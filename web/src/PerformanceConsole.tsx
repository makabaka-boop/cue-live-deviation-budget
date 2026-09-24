import { ConsoleStore, useStore, type ConsoleError } from './stores';
import type { Performance, PerformanceStatus } from './api';

const STATUS_LABELS: Record<PerformanceStatus, string> = {
  pending: '待演',
  running: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

/** Independent entry 0: performance session console. */
export default function PerformanceConsole({ store }: { store: ConsoleStore }) {
  const s = useStore(store);
  const { session } = s;

  return (
    <section className="console">
      <div className="console-entry">
        <label className="field">
          <span>创建场次（舞台监督）</span>
          <span className="field-row">
            <input
              type="text"
              value={s.nameDraft}
              onChange={(e) => store.setName(e.target.value)}
              placeholder="场次名称，例如：9 月 17 日晚场"
              disabled={s.commandBusy}
            />
            <button onClick={() => store.create()} disabled={s.commandBusy}>
              创建
            </button>
          </span>
        </label>
        <label className="field">
          <span>按 ID 载入快照</span>
          <span className="field-row">
            <input
              type="text"
              value={s.loadIdDraft}
              onChange={(e) => store.setLoadId(e.target.value)}
              placeholder="场次 ID（UUID）"
              disabled={s.loadBusy}
              spellCheck={false}
            />
            <button className="secondary" onClick={() => store.load()} disabled={s.loadBusy}>
              {s.loadBusy ? '载入中…' : '载入'}
            </button>
          </span>
        </label>
      </div>

      {s.commandBusy && (
        <p className="busy-note" role="status">
          命令提交中…即使切换到偏差校验页，结果仍会回到本页场次。
        </p>
      )}

      {s.error && <ErrorBanner error={s.error} />}

      {!session && (
        <p className="console-empty">尚未打开场次：创建一场新演出，或按 ID 载入已有场次。</p>
      )}

      {session && (
        <article className="session">
          <header className="session-head">
            <div>
              <h2>{session.name}</h2>
              <p className="session-id" title={session.id}>
                ID：<code>{session.id}</code>
              </p>
            </div>
            <span className={`badge badge-${session.status}`}>
              {STATUS_LABELS[session.status]}
            </span>
          </header>

          <dl className="facts">
            <div>
              <dt>版本</dt>
              <dd>{session.version}</dd>
            </div>
            <div>
              <dt>已登记 cue</dt>
              <dd>{session.cues.length}</dd>
            </div>
            <div className="fact-wide">
              <dt>最近提交请求标识</dt>
              <dd>
                <code>{session.requestId ?? '—'}</code>
              </dd>
            </div>
          </dl>

          {session.status === 'pending' && (
            <div className="actions">
              <button onClick={() => store.transition('running')} disabled={s.commandBusy}>
                开演（待演 → 运行）
              </button>
            </div>
          )}

          {session.status === 'running' && (
            <>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => store.transition('paused')}
                  disabled={s.commandBusy}
                >
                  暂停
                </button>
                <button
                  className="danger"
                  onClick={() => store.transition('ended')}
                  disabled={s.commandBusy}
                >
                  结束
                </button>
              </div>
              <div className="cue-entry">
                <label className="field">
                  <span>逐条登记整数 cue（仅运行态可写入；提交后才清空，失败可重试）</span>
                  <span className="field-row">
                    <input
                      type="number"
                      step={1}
                      value={s.cueDraft}
                      onChange={(e) => store.setCueDraft(e.target.value)}
                      placeholder="整数 cue，如 101"
                      disabled={s.commandBusy}
                    />
                    <button onClick={() => store.registerCue()} disabled={s.commandBusy}>
                      {s.commandBusy ? '提交中…' : '登记'}
                    </button>
                  </span>
                </label>
              </div>
            </>
          )}

          {session.status === 'paused' && (
            <div className="actions">
              <button onClick={() => store.transition('running')} disabled={s.commandBusy}>
                继续（→ 运行）
              </button>
              <button
                className="danger"
                onClick={() => store.transition('ended')}
                disabled={s.commandBusy}
              >
                结束
              </button>
            </div>
          )}

          <Timeline session={session} />
        </article>
      )}
    </section>
  );
}

function ErrorBanner({ error }: { error: ConsoleError }) {
  return (
    <div className="verdict error console-error" role="alert">
      <strong>
        <code>{error.code}</code>
        {error.reason ? (
          <>
            {' '}
            / <code>{error.reason}</code>
          </>
        ) : null}
      </strong>
      <span>{error.message}</span>
      <span className="error-hint">当前场次保留在页面上，数据未被改动。</span>
    </div>
  );
}

function Timeline({ session }: { session: Performance }) {
  const sealed = session.status === 'ended';
  return (
    <div className={`timeline${sealed ? ' sealed' : ''}`}>
      <h3>
        {sealed ? '封存时间线（只读）' : '现场时间线'}
        <span className="timeline-count">{session.cues.length} 条</span>
      </h3>
      {session.cues.length === 0 ? (
        <p className="timeline-empty">暂无 cue。</p>
      ) : (
        <ol className="cue-list">
          {session.cues.map((cue, i) => (
            <li key={i}>
              <span className="cue-index">#{i + 1}</span>
              <span className="cue-value">{cue}</span>
            </li>
          ))}
        </ol>
      )}
      {sealed && <p className="sealed-note">场次已结束，时间线封存，不再接受写入。</p>}
    </div>
  );
}
