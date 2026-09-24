import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { ConsoleStore, DeviationStore } from '../src/stores';
import { controlledConsoleDeps, controlledDeviationDeps, flush, perf } from './helpers';
import type { PerformanceDeviation } from '../src/api';

function d(over: {
  plan: number[];
  k: number;
  prefix: PerformanceDeviation['prefix'];
  final: PerformanceDeviation['final'];
}): PerformanceDeviation {
  return { planLength: over.plan.length, ...over };
}

function panel(): HTMLElement {
  return document.getElementById('panel-console')!;
}

const goDeviation = () => fireEvent.click(screen.getByRole('tab', { name: 'Cue 序列偏差校验' }));
const goConsole = () => fireEvent.click(screen.getByRole('tab', { name: '演出场次控制台' }));

async function settle<T>(deferred: { resolve: (v: T) => void }, value: T) {
  await act(async () => {
    deferred.resolve(value);
    await flush();
  });
}

describe('deviation card UI — same-version verdict', () => {
  it('renders recoverable verdict while running and the sealed final verdict after end', async () => {
    const c = controlledConsoleDeps();
    const stores = { console: new ConsoleStore(c.deps), deviation: new DeviationStore(controlledDeviationDeps().deps) };
    render(<App stores={stores} />);

    fireEvent.change(within(panel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '计划晚场' },
    });
    const summary = within(panel()).getByText(/可选：固定计划/);
    fireEvent.click(summary);
    fireEvent.change(within(panel()).getByPlaceholderText(/101, 102, 103/), {
      target: { value: '[101, 102, 103]' },
    });
    fireEvent.change(within(panel()).getByPlaceholderText('如 3'), {
      target: { value: '2' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: '创建' }));
    await settle(c.commands.shift()!, perf({
      id: 'P',
      name: '计划晚场',
      status: 'pending',
      version: 1,
      deviation: d({
        plan: [101, 102, 103],
        k: 2,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 3 },
      }),
    }));

    fireEvent.click(within(panel()).getByRole('button', { name: /开演/ }));
    await settle(c.commands.shift()!, perf({
      id: 'P',
      name: '计划晚场',
      status: 'running',
      version: 2,
      deviation: d({
        plan: [101, 102, 103],
        k: 2,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 3 },
      }),
    }));

    const cueInput = await waitFor(() =>
      within(panel()).getByPlaceholderText('整数 cue，如 101'),
    );
    fireEvent.change(cueInput, { target: { value: '101' } });
    fireEvent.click(within(panel()).getByRole('button', { name: '登记' }));
    await settle(c.commands.shift()!, perf({
      id: 'P',
      name: '计划晚场',
      status: 'running',
      version: 3,
      cues: [101],
      deviation: d({
        plan: [101, 102, 103],
        k: 2,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 2 },
      }),
    }));

    // Mid-show: prefix reading = recoverable, verdict attributed to v3.
    expect(within(panel()).getByRole('heading', { name: /仍可追回/ })).toBeTruthy();
    expect(within(panel()).getByText(/同属版本/).textContent).toContain('3');

    // A tab round-trip never unmounts the panel; the verdict survives.
    goDeviation();
    goConsole();
    expect(within(panel()).getByRole('heading', { name: /仍可追回/ })).toBeTruthy();

    fireEvent.click(within(panel()).getByRole('button', { name: '结束' }));
    await settle(c.commands.shift()!, perf({
      id: 'P',
      name: '计划晚场',
      status: 'ended',
      version: 4,
      cues: [101],
      deviation: d({
        plan: [101, 102, 103],
        k: 2,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 2 },
      }),
    }));

    // Sealed: the card switches to the FULL-plan final verdict at v4.
    expect(within(panel()).getByRole('heading', { name: /终局：偏差在容许范围内/ })).toBeTruthy();
    expect(within(panel()).getByText(/与完整计划的最终距离/).textContent).toContain('2');
    expect(within(panel()).getByText(/同属版本/).textContent).toContain('4');
    // The fixed plan is visible in the review fold.
    const reviewSummary = panel().querySelector('.deviation-card summary')!;
    fireEvent.click(reviewSummary);
    expect(within(panel()).getByText('[101,102,103]')).toBeTruthy();
  });

  it('shows the unrecoverable warning once the prefix boundary exceeds K', async () => {
    const c = controlledConsoleDeps();
    const stores = { console: new ConsoleStore(c.deps), deviation: new DeviationStore(controlledDeviationDeps().deps) };
    render(<App stores={stores} />);

    fireEvent.change(within(panel()).getByPlaceholderText('场次名称，例如：9 月 17 日晚场'), {
      target: { value: '超限场' },
    });
    fireEvent.click(within(panel()).getByText(/可选：固定计划/));
    fireEvent.change(within(panel()).getByPlaceholderText(/101, 102, 103/), {
      target: { value: '[1, 2]' },
    });
    fireEvent.change(within(panel()).getByPlaceholderText('如 3'), {
      target: { value: '1' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: '创建' }));
    await settle(c.commands.shift()!, perf({
      id: 'E',
      name: '超限场',
      status: 'pending',
      version: 1,
      deviation: d({
        plan: [1, 2],
        k: 1,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 2 },
      }),
    }));
    fireEvent.click(within(panel()).getByRole('button', { name: /开演/ }));
    await settle(c.commands.shift()!, perf({
      id: 'E', name: '超限场', status: 'running', version: 2,
      deviation: d({
        plan: [1, 2], k: 1,
        prefix: { status: 'ok', distance: 0 },
        final: { status: 'ok', distance: 2 },
      }),
    }));

    const cueInput = await waitFor(() => within(panel()).getByPlaceholderText('整数 cue，如 101'));
    // First stray cue: deleting it alone = 1, still recoverable.
    fireEvent.change(cueInput, { target: { value: '9' } });
    fireEvent.click(within(panel()).getByRole('button', { name: '登记' }));
    await settle(c.commands.shift()!, perf({
      id: 'E', name: '超限场', status: 'running', version: 3, cues: [9],
      deviation: d({
        plan: [1, 2], k: 1,
        prefix: { status: 'ok', distance: 1 },
        final: { status: 'exceeded' },
      }),
    }));
    expect(within(panel()).getByRole('heading', { name: /仍可追回/ })).toBeTruthy();

    // Second stray cue: two deletions > K, unrecoverable; it stays flagged.
    fireEvent.change(within(panel()).getByPlaceholderText('整数 cue，如 101'), {
      target: { value: '8' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: '登记' }));
    await settle(c.commands.shift()!, perf({
      id: 'E', name: '超限场', status: 'running', version: 4, cues: [9, 8],
      deviation: d({
        plan: [1, 2], k: 1,
        prefix: { status: 'exceeded' },
        final: { status: 'exceeded' },
      }),
    }));

    expect(within(panel()).getByRole('heading', { name: /已超出容许范围/ })).toBeTruthy();
    expect(within(panel()).getByText(/无法追回/)).toBeTruthy();
    expect(within(panel()).getByText(/同属版本/).textContent).toContain('4');
    expect(within(panel()).getByText('超限')).toBeTruthy();
  });
});
