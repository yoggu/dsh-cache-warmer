window.__ModuleLoader__.load({
  id: 'dsh-cache-warmer',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    const route = '/api/dsh-cache-warmer';
    /** Projection the host half publishes as the popup's change signal. */
    const OBSERVATION_KEY = 'dsh-cache-warmer.observations';
    /** Stand-in for a slot context that does not carry the projection hook. */
    const noObservations = () => undefined;
    // Bound the whole read, including response.json(). Aborting fetch alone is
    // insufficient if an intermediary never settles its promise after abort.
    // A caller may widen the bound: discovery waits on provider work that this
    // plugin cannot cancel, and a host busy with one read cannot answer the
    // other until it returns.
    function readJson(url, controller, deadlineMs = 10000) {
      let timer, onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => { const error = new Error('Request cancelled'); error.name = 'AbortError'; reject(error); };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Request timed out'); error.name = 'TimeoutError';
          reject(error);
          controller.abort();
        }, deadlineMs);
      });
      const request = Promise.resolve().then(() => {
        if (controller.signal.aborted) { const error = new Error('Request cancelled'); error.name = 'AbortError'; throw error; }
        return fetch(url, { credentials: 'include', signal: controller.signal, cache: 'no-store' });
      }).then(response => {
        if (!response.ok) throw new Error('Request failed');
        return response.json();
      });
      return Promise.race([request, deadline, cancelled]).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
      });
    }
    const readTime = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'string' || !value.trim()) return NaN;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : Date.parse(value);
    };
    const finiteNumber = (value) => {
      if (value === null || value === undefined || value === '') return NaN;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    };


    // Match the host Tooltip surface without importing private UI components.
    function PillTooltip({ anchor, text, visible, id }) {
      const ref = React.useRef(null);
      const [pos, setPos] = React.useState(null);
      React.useEffect(() => {
        if (!visible) { setPos(null); return; }
        const timer = setTimeout(() => {
          const a = anchor.current?.getBoundingClientRect();
          const tip = ref.current;
          if (a && tip) setPos({ left: Math.max(8, Math.min(a.left + a.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8)), top: Math.max(8, a.top - tip.offsetHeight - 6) });
        }, 350);
        const hide = () => setPos(null);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        const key = e => { if (e.key === 'Escape') hide(); };
        document.addEventListener('keydown', key);
        return () => { clearTimeout(timer); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); document.removeEventListener('keydown', key); };
      }, [visible, text]);
      return visible ? createPortal(React.createElement('span', {ref, id, role:'tooltip', style:{
        position:'fixed', zIndex:1100, width:'max-content', maxWidth:'50vw', boxSizing:'border-box',
        padding:'3px 7px', borderRadius:'var(--dsw-radius-sm)', background:'var(--dsw-alias-tooltip-bg)',
        color:'var(--dsw-static-neutral-bluish-00)', fontFamily:'inherit', fontSize:13, lineHeight:'20px',
        whiteSpace:'pre-line', overflowWrap:'break-word', pointerEvents:'none',
        visibility:pos ? 'visible' : 'hidden', left:pos?.left ?? 0, top:pos?.top ?? 0,
      }}, text), document.body) : null;
    }

    function createLabels(locale) {
      const zh = String(locale || 'en').toLowerCase().startsWith('zh');
      return zh ? {
        unknownTtl: '缓存时间 —', ttl: '预计剩余缓存时间', remaining: '缓存时间 ~',
        toggle: '保持缓存活跃', status: '缓存保温', phase: '阶段',
        reason: '说明', lastHit: '上次命中的缓存令牌', lastHitAt: '上次缓存命中', lastWarm: '上次保温请求',
        observationOnly: '仅供观察', unknown: '有效期尚未确认',
        inactive: '未启用', active: '活跃', idle: '空闲', running: '运行中',
        nextRefresh: '下次保温评估', windowEnds: '保温窗口结束',
        unavailable: '状态不可用', loading: '加载中…',
        failed: '无法加载缓存状态', saveFailed: '无法保存设置',
        unsupported: '此模型线路尚不支持自动保温', expired: '已过期',
        minutes: '分钟', seconds: '秒', enabled: '已启用', disabled: '已停用',
        unverified: '尚未验证此线路的有界保温请求和实际缓存收益。',
        noStorage: '持久化设置不可用；已停止自动保温。', noConsent: '此会话尚未启用自动保温。',
        windowClosed: '已超出设定的活跃时间窗口。',
      } : {
        unknownTtl: 'Cache time —', ttl: 'Estimated cache time remaining', remaining: 'Cache time ~',
        toggle: 'Keep cache warm', status: 'Cache warming', phase: 'Phase',
        reason: 'Note', lastHit: 'Last cached tokens', lastHitAt: 'Last cache hit', lastWarm: 'Last warm request',
        observationOnly: 'Observation only', unknown: 'No reliable TTL',
        inactive: 'Inactive', active: 'Active', idle: 'Idle', running: 'Running',
        nextRefresh: 'Next warming decision', windowEnds: 'Warming window ends',
        unavailable: 'Status unavailable', loading: 'Loading …',
        failed: 'Could not load cache status', saveFailed: 'Could not save the setting',
        unsupported: 'Not supported for this route', expired: 'Expired',
        minutes: 'min', seconds: 's', enabled: 'Enabled', disabled: 'Disabled',
        unverified: 'A bounded warm request and real cache benefit have not yet been verified for this route.',
        noStorage: 'Durable preferences are unavailable; warming is disabled.',
        noConsent: 'Warming is not enabled for this session.', windowClosed: 'The configured activity window has ended.',
      };
    }

    // Keep the summary independent from monetary metrics and host prose. Older
    // hosts may omit warmingState; never infer a scheduled request from "ready" alone.
    function warmingSummary(status, { loading, error, locale, now }) {
      const zh = String(locale).toLowerCase().startsWith('zh');
      const states = zh ? {
        scheduled: '已安排', warming: '保温中', waiting: '等待中', skipped: '已跳过',
        stopped: '已停止', disabled: '已停用', unavailable: '不可用',
      } : {
        scheduled: 'Scheduled', warming: 'Warming', waiting: 'Waiting', skipped: 'Skipped',
        stopped: 'Stopped', disabled: 'Disabled', unavailable: 'Unavailable',
      };
      const descriptions = zh ? {
        scheduled: '发送前会再次检查条件。', warming: '后台请求正在刷新缓存。',
        waiting: '正在等待满足保温条件。', skipped: '本次评估未满足保温条件。',
        stopped: '自动保温已停止；等待新的实际请求。', disabled: '此会话尚未启用自动保温。',
        unavailable: '当前无法获取保温状态。',
      } : {
        scheduled: 'Conditions are checked again before sending.', warming: 'A background request is refreshing the cache.',
        waiting: 'Waiting for warming conditions to be met.', skipped: 'Warming conditions were not met for this decision.',
        stopped: 'Warming has stopped until a new real request.', disabled: 'Warming is not enabled for this session.',
        unavailable: 'Warming status is currently unavailable.',
      };
      const reasons = zh ? {
        unsupported: '此线路暂无兼容的保温传输。', 'unknown-lifetime': '尚未设置缓存有效期估计；仅供观察。',
        'unsafe-thinking-budget': '保留此请求的原生推理预算会超过安全的保温输出上限。',
        'unsupported-no-retry': '此原生 SDK 无法停用保温请求的重试。',
        'unsupported-version': '此原生适配器或序列化版本未经验证。',
        'client-bound-opt-in-required': '请在插件设置中允许尽力而为的保温；此线路没有保证的服务端输出上限。',
        'policy-disabled': '此模型的缓存策略已禁止保温。', 'retention-disabled': '此线路已停用提示缓存保留。',
        'unknown-pricing': '模型价格未知，无法检查保温收益。', 'no-cache-evidence': '等待实际请求报告缓存命中。',
        'no-context': '等待新的已完成请求，以获取当前上下文。', disabled: descriptions.disabled,
        'request-in-flight': '等待当前请求完成。',
        'request-identity-unavailable': '无法识别当前请求，已停用自动保温。',
        'window-ended': '距上次实际请求的保温窗口已结束。', 'window-too-short': '剩余保温窗口不足以安排下一次刷新。',
        'insufficient-savings': '预计节省不足。',
        'cache-elapsed': '预计缓存有效期已过；等待实际请求。', stopped: '因错误、未命中、取消或上下文变化而停止。',
        'no-storage': '持久化设置或费用记录不可用，已停止保温。',
        'transport-pending': '等待上一次后台请求完成关闭。', 'decision-pending': '正在等待下一次保温评估。',
        'idle-probability-zero': '继续对话概率设为零，已停用空闲保温。',
        'session-unavailable': '当前会话不可用。', 'economics-missing-pricing': '缺少价格信息，无法检查保温收益。',
        ready: descriptions.waiting, warming: descriptions.warming,
      } : {
        unsupported: 'No compatible warming transport is available for this route.',
        'unsafe-thinking-budget': 'Preserving this request’s native thinking budget would exceed the safe refresh output cap.',
        'unsupported-no-retry': 'The native SDK cannot disable cache-refresh retries.',
        'unsupported-version': 'This native adapter or serializer version is not reviewed.',
        'unknown-lifetime': 'No cache lifetime estimate is configured; observation only.',
        'client-bound-opt-in-required': 'Enable best-effort warming in plugin settings; this route has no guaranteed server-side output cap.',
        'policy-disabled': 'The model cache policy disables warming.', 'retention-disabled': 'Prompt cache retention is disabled for this route.',
        'unknown-pricing': 'Model pricing is unknown, so the cost check cannot run.', 'no-cache-evidence': 'Waiting for a real request to report a cache hit.',
        'no-context': 'Waiting for a completed real request with current context.', disabled: descriptions.disabled,
        'request-in-flight': 'Waiting for the current request to finish.',
        'request-identity-unavailable': 'The current request cannot be identified, so warming is disabled.',
        'window-ended': 'The warming window after the last real request has ended.',
        'window-too-short': 'The remaining warming window is too short for another refresh.',
        'insufficient-savings': 'Expected savings are too low.',
        'cache-elapsed': 'The estimated cache lifetime has elapsed; waiting for a real request.',
        stopped: 'Warming stopped after an error, miss, cancellation or context change.',
        'no-storage': 'Durable preferences or usage records are unavailable, so warming has stopped.',
        'transport-pending': 'Waiting for the previous background request to finish closing.', 'decision-pending': 'Waiting for the next warming decision.',
        'idle-probability-zero': 'Idle warming is disabled by the continuation probability setting.',
        'session-unavailable': 'The current session is unavailable.', 'economics-missing-pricing': 'Pricing is missing, so the cost check cannot run.',
        ready: descriptions.waiting, warming: descriptions.warming,
      };
      if (loading) return { state: 'unavailable', label: states.unavailable, description: zh ? '正在加载保温状态。' : 'Loading warming status.' };
      if (error === 'load' || !status || typeof status !== 'object' || Array.isArray(status)) {
        return { state: 'unavailable', label: states.unavailable, description: error === 'load'
          ? (zh ? '无法加载保温状态，请稍后重试。' : 'Could not load warming status; try again shortly.') : descriptions.unavailable };
      }
      const reason = status.reasonCode === 'unsupported' && status.transportReasonCode
        ? status.transportReasonCode : status.reasonCode;
      let state = Object.hasOwn(states, status.warmingState) ? status.warmingState : null;
      if (!state) {
        if (status.warming === true) state = 'warming';
        else if (status.enabled === false || ['disabled', 'policy-disabled', 'client-bound-opt-in-required', 'retention-disabled', 'idle-probability-zero'].includes(reason)) state = 'disabled';
        else if (status.supported === false || ['unsupported', 'no-storage', 'unknown-lifetime', 'unknown-pricing', 'request-identity-unavailable', 'session-unavailable', 'economics-missing-pricing'].includes(reason)) state = 'unavailable';
        else if (['stopped', 'window-ended', 'window-too-short', 'cache-elapsed'].includes(reason)) state = 'stopped';
        else if (reason === 'insufficient-savings') state = 'skipped';
        else if (reason === 'ready' && readTime(status.nextRefreshAt) > now) state = 'scheduled';
        else state = typeof status.warming === 'boolean' || typeof reason === 'string' || typeof status.enabled === 'boolean' ? 'waiting' : 'unavailable';
      }
      const description = state === 'scheduled' || state === 'warming' ? descriptions[state] : reasons[reason] || descriptions[state];
      return { state, label: states[state], description };
    }

    function formatDuration(ms, labels) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (minutes) return `${minutes} ${labels.minutes}${rest ? ` ${rest} ${labels.seconds}` : ''}`;
      return `${seconds} ${labels.seconds}`;
    }

    function formatTimestamp(value, locale) {
      const time = readTime(value);
      if (!Number.isFinite(time)) return null;
      try {
        return new Intl.DateTimeFormat(locale || undefined, {
          hour: '2-digit', minute: '2-digit',
        }).format(new Date(time));
      } catch {
        return new Date(time).toLocaleTimeString();
      }
    }

    function getLocale(ctx) {
      try {
        const value = ctx.locale && typeof ctx.locale.getLocale === 'function'
          ? ctx.locale.getLocale()
          : null;
        if (typeof value === 'string') return value;
        return value && (value.active || value.locale || value.language) || 'en';
      } catch {
        return 'en';
      }
    }

    function CachePill({ sessionId, ctx, useProjection }) {
      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const tipId = React.useId();
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const [panelPos, setPanelPos] = React.useState(null);
      const [now, setNow] = React.useState(Date.now());
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const labels = createLabels(locale);
      // The host status is re-read on events, never on an interval: an
      // untouched Session costs no requests at all.
      const refreshRef = React.useRef(null);
      const baselineSeen = React.useRef(false);
      const announcedTarget = React.useRef(0);
      // A slot context without the projection seat still renders; it simply has
      // no push signal and re-reads when the popup opens instead.
      const useObservations = typeof useProjection === 'function' ? useProjection : noObservations;
      const observation = useObservations(OBSERVATION_KEY);

      const enabled = Boolean(status && status.enabled);
      const supported = Boolean(status && status.supported);
      const ttlMs = finiteNumber(status && status.cacheTtlMs);
      const expiresAt = readTime(status && status.cacheExpiresAt);
      const hasTtl = Number.isFinite(ttlMs) && ttlMs > 0;
      const hasExpiry = hasTtl && Number.isFinite(expiresAt);
      const remainingMs = hasExpiry ? Math.max(0, expiresAt - now) : NaN;
      const ringRatio = hasExpiry ? Math.max(0, Math.min(1, remainingMs / ttlMs)) : 0;
      const pillText = hasExpiry
        ? `${labels.remaining}${Math.ceil(remainingMs / 60000)}${locale.startsWith('zh') ? '分钟' : 'm'}`
        : labels.unknownTtl;

      React.useEffect(() => {
        const localeApi = ctx.locale;
        if (!localeApi || typeof localeApi.subscribe !== 'function') return undefined;
        const updateLocale = () => setLocale(getLocale(ctx));
        try {
          const unsubscribe = localeApi.subscribe(updateLocale);
          return typeof unsubscribe === 'function' ? unsubscribe : undefined;
        } catch {
          return undefined;
        }
      }, []);

      React.useEffect(() => {
        if (!sessionId) {
          setStatus(null);
          setLoading(false);
          refreshRef.current = null;
          return undefined;
        }
        let alive = true;
        let inFlight = false;
        let controller;
        // Single flight: a burst of waking events still costs one read.
        const refresh = async () => {
          if (inFlight) return;
          inFlight = true;
          controller = new AbortController();
          try {
            const payload = await readJson(`${route}?sessionId=${encodeURIComponent(sessionId)}`, controller);
            if (alive) {
              setStatus(payload && typeof payload === 'object' ? payload : null);
              setError('');
            }
          } catch (cause) {
            if (alive && cause.name !== 'AbortError') setError('load');
          } finally {
            inFlight = false;
            if (alive) setLoading(false);
          }
        };
        refreshRef.current = refresh;
        setLoading(true);
        refresh();
        return () => {
          alive = false;
          refreshRef.current = null;
          if (controller) controller.abort();
        };
      }, [sessionId]);

      // While the popup is open, a new durable observation is the one event
      // that can move the shown status by itself, so re-read exactly then. A
      // closed popup shows only the local countdown and spends nothing, and the
      // first defined value is the follow baseline rather than a change.
      React.useEffect(() => {
        if (!open || observation === undefined) return;
        if (!baselineSeen.current) { baselineSeen.current = true; return; }
        refreshRef.current?.();
      }, [observation, open]);

      // Opening the popup is a user read of the live status: always fresh.
      React.useEffect(() => {
        if (!open) return;
        announcedTarget.current = 0;
        refreshRef.current?.();
      }, [open]);

      // The host states when its own decision points are; while the popup is
      // open, wake exactly then — once per announced moment, never on a timer.
      React.useEffect(() => {
        if (!open || !status) return undefined;
        const targets = [readTime(status.nextRefreshAt), readTime(status.windowEndsAt), expiresAt]
          .filter(target => Number.isFinite(target) && target > Date.now() + 1000);
        if (!targets.length) return undefined;
        const target = Math.min(...targets);
        // A target already used, or one the host keeps restating, must not
        // schedule again: the next read is always a strictly later moment.
        if (target <= announcedTarget.current) return undefined;
        const timer = setTimeout(() => { announcedTarget.current = target; refreshRef.current?.(); }, target - Date.now() + 100);
        return () => clearTimeout(timer);
      }, [open, status]);

      // Local clock only: wake when the displayed minute changes, and not at
      // all once the estimate has elapsed or is unknown.
      React.useEffect(() => {
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
        const offset = remainingMs % 60000;
        const timer = setTimeout(() => setNow(Date.now()), (offset === 0 ? 60000 : offset) + 50);
        return () => clearTimeout(timer);
      }, [remainingMs]);
      React.useEffect(() => {
        if (!open) { setPanelPos(null); return undefined; }
        const place = () => {
          const trigger = triggerRef.current;
          const panel = panelRef.current;
          if (!trigger || !panel) return;
          const anchor = trigger.getBoundingClientRect();
          const width = panel.offsetWidth;
          const height = panel.offsetHeight;
          const margin = 12;
          const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
          const above = anchor.top - height - 8;
          const top = above >= margin ? above : Math.min(window.innerHeight - height - margin, anchor.bottom + 8);
          setPanelPos({ left, top: Math.max(margin, top) });
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          setOpen(false);
          triggerRef.current?.querySelector('button')?.focus();
        };
        const onPointerDown = (event) => {
          if (!triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        const observer = new ResizeObserver(place);
        observer.observe(panelRef.current);
        observer.observe(triggerRef.current);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
          observer.disconnect();
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown);
        };
      }, [open]);

      const requestEnabled = async (nextEnabled) => {
        if (!sessionId || (nextEnabled && !supported) || saving) return;
        setSaving(true);
        setError('');
        try {
          const response = await fetch(route, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ sessionId, enabled: nextEnabled }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => null);
          if (payload && typeof payload === 'object') setStatus(payload);
          else setStatus((previous) => ({ ...(previous || {}), enabled: nextEnabled }));
        } catch {
          setError('save');
        } finally {
          setSaving(false);
        }
      };

      const textStyle = { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' };
      const mutedStyle = { color: 'var(--dsw-alias-label-tertiary)' };
      const pillStyle = {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: '100%', padding: '1px var(--dsh-cache-pill-inline, 8px)', border: 0, borderRadius: 999,
        background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'inherit', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        cursor: 'pointer', whiteSpace: 'nowrap',
      };
      const popoverStyle = {
        position: 'fixed', zIndex: 1100, left: panelPos?.left ?? 0, top: panelPos?.top ?? 0,
        visibility: panelPos ? 'visible' : 'hidden',
        width: 'min(320px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto', boxSizing: 'border-box', padding: 16,
        border: 0, borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-specific-menu)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
        fontFamily: 'inherit', fontSize: 12, lineHeight: '18px',
      };
      const rowStyle = {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        gap: 16, paddingTop: 6,
      };
      const timeLabel = (name, value) => {
        const formatted = formatTimestamp(value, locale);
        return formatted ? h('div', { key: name, style: rowStyle },
          h('span', { style: mutedStyle }, name), h('span', { style: textStyle }, formatted)) : null;
      };
      const hitTokens = finiteNumber(status && status.lastCacheHitTokens);
      const zh = locale.toLowerCase().startsWith('zh');
      const summary = warmingSummary(status, { loading, error, locale, now });
      const elapsedText = zh ? '预计有效期已过（不代表缓存已删除）' : 'Estimated lifetime elapsed (not confirmed eviction)';
      const tooltipText = hasExpiry ? (remainingMs > 0 ? labels.ttl : elapsedText)
        : (zh ? '缓存有效期未知' : 'Cache lifetime unknown');
      const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(3)}` : '—';
      const metric = (name, value, title) => h('div', { key: name, style: rowStyle, title },
        h('span', { style: mutedStyle }, name), h('span', { style: textStyle }, value));
      const lifetimeText = hasTtl ? formatDuration(ttlMs, labels) : (zh ? '未知' : 'Unknown');
      const remainingText = hasExpiry ? (remainingMs > 0 ? `~${Math.ceil(remainingMs / 60000)} ${labels.minutes}` : (zh ? '已过期' : 'Elapsed'))
        : (zh ? '未知' : 'Unknown');
      const errorText = error === 'save' ? labels.saveFailed : '';
      const showRing = hasExpiry;

      return h('span', {
        ref: triggerRef, className: 'dsh-cache-warmer-anchor',
        style: { position: 'relative', display: 'inline-flex', minWidth: 0, verticalAlign: 'middle' },
      },
        h('button', {
          type: 'button', style: { ...pillStyle,
            ...(open || hover ? {
              background: 'var(--dsw-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-tertiary)',
            } : {}),
          },
          onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true), onBlur: () => setHover(false),
          'aria-describedby': hover && !open ? tipId : undefined,
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open, 'aria-haspopup': 'dialog',
          'aria-label': pillText,
        },
          showRing ? h('svg', {
            width: 15, height: 15, viewBox: '0 0 20 20', 'aria-hidden': true,
            style: { flex: '0 0 auto', display: 'block' },
          },
            h('circle', {
              cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)',
              strokeOpacity: 0.35, strokeWidth: 2,
            }),
            h('circle', {
              cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)',
              strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: 50.27,
              strokeDashoffset: 50.27 * (1 - ringRatio), transform: 'rotate(-90 10 10)',
            })) : h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', 'aria-hidden': true,
            style: { display: 'block', flex: '0 0 auto' } },
            h('circle', { cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'currentColor',
              strokeOpacity: 0.65, strokeWidth: 2 })), 
          h('span', { className: 'dsh-cache-warmer-label', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, pillText)),
        h(PillTooltip, {anchor:triggerRef, text:tooltipText, visible:hover && !open, id:tipId}),
        open && createPortal(h('div', { className: 'dsh-cache-warmer-panel', ref: panelRef, role: 'dialog', 'aria-label': labels.status, style: popoverStyle },
          h('div', { className: 'dsh-cache-warmer-header',
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 } },
            h('h3', { className: 'dsh-cache-warmer-title',
              style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, labels.status),
            h('span', { className: 'dsh-cache-warmer-state', 'data-warming-state': summary.state,
              style: { flexShrink: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, summary.label)),
          h('div', { className: 'dsh-cache-warmer-description', role: error === 'load' ? 'alert' : 'status',
            style: { marginBottom: 12, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '20px', overflowWrap: 'anywhere' } }, summary.description),
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, lineHeight: '20px', cursor: supported || enabled ? 'pointer' : 'not-allowed' },
          },
            h('input', {
              className: 'dsh-cache-warmer-check', type: 'checkbox', checked: enabled,
              disabled: (!supported && !enabled) || saving || !sessionId,
              onChange: (event) => requestEnabled(event.target.checked),
              style: { accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: textStyle }, labels.toggle)),
          h('div', { 'aria-hidden': true, style: { borderTop: '.5px solid var(--dsw-alias-border-l2)', marginBottom: 4 } }),
          metric(zh ? '剩余时间' : 'Time remaining', remainingText, hasExpiry && remainingMs === 0 ? elapsedText : undefined),
          metric(zh ? '缓存有效期' : 'Cache lifetime', lifetimeText),
          Number.isFinite(hitTokens) && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.lastHit), h('span', { style: textStyle }, hitTokens.toLocaleString(locale))),
          timeLabel(labels.lastHitAt, status && status.lastCacheHitAt),
          timeLabel(labels.lastWarm, status && status.lastWarmAt),
          timeLabel(labels.nextRefresh, status && status.nextRefreshAt),
          timeLabel(labels.windowEnds, status && status.windowEndsAt),
          status?.decision && h(React.Fragment, null,
            metric(zh ? '预计刷新费用' : 'Estimated refresh cost', money(status.decision.refreshCostUsd)),
            metric(zh ? '预计净收益' : 'Expected net benefit', money(status.decision.expectedSavingsUsd)),
            metric(zh ? '继续对话概率' : 'Continuation probability', `${Math.round(status.decision.probability * 100)}%`)),
          status?.warmUsage && h(React.Fragment, null,
            metric(zh ? '保温请求次数' : 'Warm requests', String(status.warmUsage.attempts)),
            metric(zh ? '保温费用估计' : 'Warm usage estimate', `${money(status.warmUsage.usd)}${status.warmUsage.unpriced ? (zh ? ' · 部分' : ' · partial') : ''}`)),
          status?.outputBound === 'client' && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            zh ? '尽力而为：没有保证的服务端输出上限。隐藏推理及客户端取消后的生成仍可能消耗用量。'
              : 'Best effort: no guaranteed server-side output cap. Hidden reasoning and generation after client cancellation may still consume usage.'),
          status?.decision?.subscription && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            zh ? '金额为 API 等价估计，并非账单或订阅配额。保温会消耗用量。'
              : 'Dollars are API-equivalent estimates, not a bill or subscription quota. Warming consumes usage.'),
          errorText && h('div', {
            role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', paddingTop: 8 },
          }, errorText),
        ), document.body));
    }

    function SettingsPage({ ctx }) {
      const [values, setValues] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [settingsRequest, setSettingsRequest] = React.useState(0);
      const [catalog, setCatalog] = React.useState({ providers: [] });
      const [modelsLoading, setModelsLoading] = React.useState(true);
      const [modelsRequest, setModelsRequest] = React.useState(0);
      const [search, setSearch] = React.useState('');
      const [providerFilter, setProviderFilter] = React.useState('');
      const [limit, setLimit] = React.useState(25);
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const zh = locale.toLowerCase().startsWith('zh');
      const helpId = React.useId();
      // Catalog metadata never enters the editable settings or a POST body.
      const editable = value => ({ autoWarmNewChats: value.autoWarmNewChats, activeMinutes: value.activeMinutes,
        idleMinutes: value.idleMinutes, useCodexDefaults: value.useCodexDefaults !== false,
        allowClientBoundWarming: value.allowClientBoundWarming === true,
        minExpectedBenefitUsd: value.minExpectedBenefitUsd === undefined ? 0.05 : value.minExpectedBenefitUsd,
        idleContinuationPercent: value.idleContinuationPercent === undefined ? 15 : value.idleContinuationPercent,
        modelPolicies: (value.modelPolicies || []).map(row => ({ provider: row.provider, model: row.model,
          enabled: row.enabled, cacheMinutes: row.cacheMinutes })) });
      const t = zh ? {
        description: '保温通过小型后台请求尝试维持已有的提示词缓存。会产生 API 费用或消耗订阅用量；仅在预计节省的费用超过保温成本时发送。',
        defaultEnabled: '默认保持新对话的缓存活跃', active: '运行中保温窗口（分钟）', idle: '空闲时保温窗口（分钟）',
        defaultHelp: '为新建的普通对话自动开启“保持缓存活跃”。不会改变已有对话或子智能体对话；每个对话仍可单独关闭。模型的保温开关也必须开启。',
        activeHelp: '智能体运行时，允许保温至上次实际模型请求后的指定分钟数。设为 0 可停用运行中保温。',
        idleHelp: '智能体空闲时，允许保温至上次实际模型请求后的指定分钟数，并非从运行结束时重新计时。设为 0 可停用空闲保温。',
        windowHelp: '这是允许保温的时间范围，不是刷新间隔或缓存有效期。实际刷新时间由下方模型的有效期估计决定；保温请求不会延长窗口。',
        windowExample: '例如：空闲窗口为 30 分钟，上次实际请求在 14:00，则保温最迟于 14:30 停止；即使运行在 14:10 才结束，也不会延后。',
        advanced: '高级 / 费用检查', benefit: '最低预计净收益（美元）', probability: '空闲时继续对话的概率（%）',
        benefitHelp: '扣除预计刷新费用后，净收益必须达到此门槛（0–1000 美元）。降低门槛可能增加保温请求和用量。',
        probabilityHelp: '空闲时再次使用缓存的本地概率假设（整数 0–100%）。提高概率可能增加保温和用量；设为 0 会阻止空闲保温。',
        costHelp: '这些值是本地决策假设，不是提供商的保证。运行中继续对话的概率固定为 100%；其他安全检查仍然生效。',
        clientBound: '允许尽力而为的保温（Codex / OAuth）',
        clientBoundHelp: '没有保证的服务端输出上限。插件请求简短回复并在客户端取消，但隐藏推理及取消后的生成仍可能消耗用量；费用估计不是支出或配额上限。',
        codexCostHelp: '使用 llm-pi-ai 的原生提供商线路。仍需模型及对话开关、缓存证据和收益检查；未知价格或不兼容能力会阻止发送。',
        invalidSettings: '窗口需为 0–1440 的整数分钟；净收益门槛需为 0–1000 的有限数字；空闲概率需为 0–100 的整数。必填项不能留空。',
        loadTimeout: '设置加载超时，请重试。', modelsTimeout: '模型加载超时。已保留现有列表和自定义规则，请重试。',
        loadError: '无法加载设置。', saveError: '保存失败；未保存的修改已保留。', save: '保存', saving: '保存中…', loading: '加载中…',
        models: '模型缓存策略', search: '搜索模型或提供商', provider: '提供商', all: '所有提供商', refresh: '刷新模型', retry: '重试', more: '加载更多',
        modelError: '无法发现此提供商的模型。已保留自定义规则。', timeout: '此提供商的模型发现超时。已保留自定义规则。',
        providerError: '无法发现提供商。已保留自定义规则，可重试。', empty: '没有匹配的模型。', unavailable: '目录中不可用',
        allow: '允许保温', lifetime: '预计缓存有效期（分钟）', unknown: '未知', custom: '自定义', estimated: '无默认估计',
        blank: '空白 — 不会自动保温', disabled: '已停用（保留有效期）', legacy: '旧设置停用了默认估计', reset: '恢复默认', remove: '移除规则',
        assumption: '不再自动使用 Codex 有效期估计。有效期只是本地调度假设，不能启用不兼容线路，也不会设置提供商的 TTL。空白会阻止自动保温。',
        discovery: '模型来自 Harness 配置的提供商。目录并不验证凭据或实际缓存 TTL；允许保温仍需兼容传输、缓存证据、对话开关和收益检查。',
        limit: '最多保存 100 条自定义规则；模型目录不受此限制。',
        invalid: '规则需使用精确的提供商/模型 ID，有效期为 1–10080 的整数分钟或空白；最多 100 条且不能重复。',
      } : {
        description: 'Warming sends small background requests to try to preserve an existing prompt cache. It consumes API or subscription usage, and runs only when the expected savings justify the cost.',
        defaultEnabled: 'Keep new chats warm by default', active: 'Warming window while running (minutes)', idle: 'Warming window while idle (minutes)',
        defaultHelp: 'Automatically turn on “Keep cache warm” for new regular chats. Existing chats and subagent chats are unchanged. You can turn it off in any chat; the model must also allow warming.',
        activeHelp: 'While the agent is running, allow warming for this many minutes after its last real model request. Set to 0 to disable warming during a run.',
        idleHelp: 'While the agent is idle, allow warming until this many minutes after its last real model request—not after the run ends. Set to 0 to disable idle warming.',
        windowHelp: 'These are time windows, not refresh intervals or cache lifetimes. Refresh timing comes from the model’s lifetime estimate below. Warm requests never extend either window.',
        windowExample: 'Example: with a 30-minute idle window and a last real request at 14:00, warming stops by 14:30—even if the run finishes at 14:10.',
        advanced: 'Advanced / Cost checks', benefit: 'Minimum expected net benefit (USD)', probability: 'Idle continuation probability (%)',
        benefitHelp: 'After the estimated refresh cost, the net benefit must reach this threshold (USD 0–1000). A lower threshold can mean more warming and usage.',
        probabilityHelp: 'Local chance of reusing the cache while idle (whole percent, 0–100). A higher probability can mean more warming and usage; 0 blocks idle warming.',
        costHelp: 'These are local decision assumptions, not provider guarantees. Continuation probability while running is fixed at 100%; other safety checks still apply.',
        clientBound: 'Allow best-effort warming (Codex / OAuth)',
        clientBoundHelp: 'No guaranteed server-side output cap. The plugin requests a short reply and cancels locally, but hidden reasoning or generation after cancellation can still consume usage. Estimates are not spending or quota caps.',
        codexCostHelp: 'Uses llm-pi-ai native provider routes. Model and chat opt-in, cache evidence and the cost check still apply; unknown prices or incompatible capabilities block sends.',
        invalidSettings: 'Windows require whole minutes from 0–1440; the benefit threshold requires a finite number from 0–1000; idle probability requires a whole percent from 0–100. Required fields cannot be blank.',
        loadTimeout: 'Settings took too long to load. Please retry.', modelsTimeout: 'Models took too long to load. Existing models and overrides are preserved; please retry.',
        loadError: 'Could not load settings.', saveError: 'Save failed; unsaved changes are preserved.', save: 'Save', saving: 'Saving …', loading: 'Loading …',
        models: 'Model cache policies', search: 'Search models or providers', provider: 'Provider', all: 'All providers', refresh: 'Refresh models', retry: 'Retry', more: 'Load more',
        modelError: 'Model discovery failed for this provider. Overrides are preserved.', timeout: 'Model discovery timed out for this provider. Overrides are preserved.',
        providerError: 'Provider discovery failed. Overrides are preserved; retry to load models.', empty: 'No matching models.', unavailable: 'Unavailable in catalog',
        allow: 'Allow warming', lifetime: 'Estimated cache lifetime (minutes)', unknown: 'Unknown', custom: 'Custom', estimated: 'No default estimate',
        blank: 'Blank — no automatic warming', disabled: 'Disabled (lifetime retained)', legacy: 'Defaults disabled by legacy settings', reset: 'Reset to default', remove: 'Remove override',
        assumption: 'Codex lifetimes are no longer assumed automatically. Lifetimes are local planning assumptions; they cannot grant a transport or set provider TTLs. Blank prevents automatic warming.',
        discovery: 'Models come from Harness configured providers. The catalog does not verify credentials or actual cache TTL. Allowing warming still requires a compatible transport, cache evidence, chat consent and the savings check.',
        limit: 'Save up to 100 overrides; the model catalog has no such limit.',
        invalid: 'Rules require exact provider/model IDs, integer minutes from 1–10080 or blank; maximum 100 overrides with no duplicates.',
      };
      const reasons = zh ? {
        'unsupported-model': '此模型无兼容传输', 'unsupported-protocol': '协议不受支持', 'unknown-pricing': '价格未知',
        'unsupported-route': '线路不受支持', 'unsupported-capability': '缺少所需能力', 'catalog-unavailable': '能力目录不可用',
        'retention-disabled': '缓存保留已停用', 'unsupported-provider': '提供商不受支持', 'route-unavailable': '线路不可用',
        'unsupported-no-retry': '原生 SDK 无法停用重试',
        'unsafe-thinking-budget': '所需推理预算超过保温输出上限',
        'unsupported-reasoning': '原生模型不支持此请求的推理级别',
        'unsupported-version': '适配器或序列化版本未经验证',
        'unsupported-fallbacks': '模型备用路由不受支持',
      } : {
        'unsupported-model': 'No compatible model transport', 'unsupported-protocol': 'Unsupported protocol', 'unknown-pricing': 'Pricing unknown',
        'unsupported-route': 'Unsupported route', 'unsupported-capability': 'Required capability unavailable', 'catalog-unavailable': 'Capability catalog unavailable',
        'retention-disabled': 'Cache retention disabled', 'unsupported-provider': 'Unsupported provider', 'route-unavailable': 'Route unavailable',
        'unsupported-no-retry': 'Native SDK retries cannot be disabled',
        'unsafe-thinking-budget': 'Required thinking budget exceeds the refresh output cap',
        'unsupported-reasoning': 'The native model does not support this request’s reasoning level',
        'unsupported-version': 'Adapter or serializer version is not reviewed',
        'unsupported-fallbacks': 'Model fallback routing is unsupported',
      };
      React.useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setError('');
        // The settings read shares the host with model discovery, so it gets
        // the same window: one slow read must not fail the other panel.
        readJson(`${route}?scope=settings`, controller, 25000)
          .then(value => { if (active) { const settings = editable(value); setValues(settings); setDraft(settings); } })
          .catch(cause => { if (active) setError(cause.name === 'TimeoutError' ? 'load-timeout' : 'load'); });
        return () => { active = false; controller.abort(); };
      }, [settingsRequest]);
      React.useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setModelsLoading(true);
        // Model discovery can wait on a slow provider once; the host then stops
        // re-asking that provider, so the wider bound is paid at most once.
        readJson(`${route}?scope=models`, controller, 25000)
          .then(value => {
            if (!value || !Array.isArray(value.providers)) throw new Error('models');
            if (active) setCatalog(value);
          })
          .catch(cause => { if (active) setCatalog(previous => ({ ...previous,
            error: cause.name === 'TimeoutError' ? 'model-request-timeout' : 'provider-discovery-failed' })); })
          .finally(() => { if (active) setModelsLoading(false); });
        return () => { active = false; controller.abort(); };
      }, [modelsRequest]);
      React.useEffect(() => {
        const api = ctx.locale;
        if (!api || typeof api.subscribe !== 'function') return undefined;
        return api.subscribe(() => setLocale(getLocale(ctx)));
      }, []);
      const set = (name, value) => setDraft(previous => ({ ...previous, [name]: value }));
      const rows = draft?.modelPolicies || [];
      const pair = row => JSON.stringify([row.provider, row.model]);
      const overrides = new Map(rows.map(row => [pair(row), row]));
      const validMinutes = n => n === null || (Number.isInteger(n) && n >= 1 && n <= 10080);
      const validRows = rows.length <= 100 && overrides.size === rows.length && rows.every(row =>
        typeof row.provider === 'string' && row.provider.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(row.provider)
        && typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 256 && row.model === row.model.trim()
        && !/[*?\[\]{}]/.test(row.model) && typeof row.enabled === 'boolean' && validMinutes(row.cacheMinutes));
      const validSettings = draft && typeof draft.autoWarmNewChats === 'boolean' && typeof draft.useCodexDefaults === 'boolean'
        && Number.isInteger(draft.activeMinutes) && draft.activeMinutes >= 0 && draft.activeMinutes <= 1440
        && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 0 && draft.idleMinutes <= 1440
        && Number.isFinite(draft.minExpectedBenefitUsd) && draft.minExpectedBenefitUsd >= 0 && draft.minExpectedBenefitUsd <= 1000
        && Number.isInteger(draft.idleContinuationPercent) && draft.idleContinuationPercent >= 0 && draft.idleContinuationPercent <= 100;
      const valid = validSettings && validRows;
      const save = async () => {
        if (!valid || busy) return;
        setBusy(true); setError('');
        try {
          const response = await fetch(route, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'settings', ...editable(draft) }) });
          if (!response.ok) throw new Error('save');
          const settings = editable(await response.json());
          setDraft(settings); setValues(settings);
        } catch { setError('save'); }
        finally { setBusy(false); }
      };
      // Merge saved/unsaved overrides into the display, never into the discovered catalog.
      const groups = new Map();
      const known = new Set();
      for (const provider of catalog.providers) {
        const group = { id: provider.id, name: provider.name || provider.id, error: provider.error, models: [] };
        groups.set(provider.id, group);
        for (const model of provider.models || []) {
          const row = { ...model, provider: provider.id, model: model.id, available: true };
          if (!known.has(pair(row))) { group.models.push(row); known.add(pair(row)); }
        }
      }
      for (const override of rows) {
        if (known.has(pair(override))) continue;
        if (!groups.has(override.provider)) groups.set(override.provider, { id: override.provider, name: override.provider, models: [] });
        groups.get(override.provider).models.push({ provider: override.provider, model: override.model, name: override.model,
          defaultCacheMinutes: null, transportSupported: false, available: false });
        known.add(pair(override));
      }
      const allGroups = [...groups.values()];
      const needle = search.trim().toLocaleLowerCase();
      let remaining = limit;
      const filtered = allGroups.filter(group => !providerFilter || group.id === providerFilter).map(group => {
        const matches = group.models.filter(model => `${group.id} ${group.name} ${model.model} ${model.name}`.toLocaleLowerCase().includes(needle));
        const visible = matches.slice(0, remaining);
        remaining -= visible.length;
        return { ...group, matches, visible };
      });
      const total = allGroups.reduce((n, group) => n + group.models.length, 0);
      const matched = filtered.reduce((n, group) => n + group.matches.length, 0);
      const displayed = Math.min(limit, matched);
      const effective = model => overrides.get(pair(model)) || {
        provider: model.provider, model: model.model,
        enabled: draft?.useCodexDefaults !== false && model.defaultCacheMinutes != null,
        cacheMinutes: draft?.useCodexDefaults !== false ? model.defaultCacheMinutes : null,
      };
      const updateModel = (model, patch) => {
        if (!draft || busy) return;
        const key = pair(model);
        setDraft(previous => {
          const old = previous.modelPolicies.find(row => pair(row) === key);
          if (!old && previous.modelPolicies.length >= 100) return previous;
          const next = { ...(old || effective(model)), ...patch };
          return { ...previous, modelPolicies: old ? previous.modelPolicies.map(row => pair(row) === key ? next : row) : [...previous.modelPolicies, next] };
        });
      };
      const removeModel = model => setDraft(previous => ({ ...previous, modelPolicies: previous.modelPolicies.filter(row => pair(row) !== pair(model)) }));
      const resetModel = model => {
        if (draft.useCodexDefaults === false && model.defaultCacheMinutes != null) updateModel(model, { enabled: true, cacheMinutes: model.defaultCacheMinutes });
        else removeModel(model);
      };
      const button = (label, onClick, disabled = false, ariaLabel = label) => h('button', {
        type: 'button', className: 'dsh-cache-policy-button', disabled, onClick, 'aria-label': ariaLabel,
      }, label);
      const settingText = (key, title, help) => h('span', { className: 'dsh-cache-settings-copy' },
        h('span', { className: 'dsh-cache-settings-label' }, title),
        h('span', { className: 'dsh-cache-settings-help', id: `${helpId}-${key}` }, help));
      const field = (key, title, help, max = 1440, step = 1) => h('label', { className: 'dsh-cache-settings-row' },
        settingText(key, title, help), h('input', { type: 'number', min: 0, max, step,
          className: 'dsh-cache-settings-input', disabled: busy, value: draft[key], 'aria-label': title,
          'aria-describedby': `${helpId}-${key}`,
          onChange: event => set(key, event.target.value.trim() === '' ? '' : Number(event.target.value)),
        }));
      const renderModel = model => {
        const row = effective(model);
        const custom = overrides.has(pair(model));
        const locked = busy || !draft || (!custom && rows.length >= 100);
        const identity = `${model.provider}/${model.model}`;
        const status = row.cacheMinutes == null ? t.blank : custom ? t.custom : t.estimated;
        return h('div', { className: 'dsh-cache-policy-card', key: pair(model), 'data-model': identity },
          h('strong', null, model.name || model.model),
          model.name !== model.model && h('div', { className: 'dsh-cache-policy-id' }, model.model),
          h('div', { className: 'dsh-cache-policy-status' }, `${status}${!row.enabled && row.cacheMinutes != null ? ` · ${t.disabled}` : ''}`),
          !custom && draft?.useCodexDefaults === false && model.defaultCacheMinutes != null && h('div', { className: 'dsh-cache-policy-status' }, t.legacy),
          !model.available ? h('div', { className: 'dsh-cache-policy-status' }, t.unavailable)
            : !model.transportSupported && h('div', { className: 'dsh-cache-policy-status' }, `${zh ? '仅供观察' : 'Observation only'} · ${reasons[model.reasonCode] || (zh ? '保温传输不受支持' : 'Warming transport unsupported')}`),
          model.transportSupported && model.outputBound === 'client' && h('div', { className: 'dsh-cache-policy-status' },
            zh ? '尽力而为 · 无保证的服务端输出上限 · 需额外允许' : 'Best effort · No guaranteed server-side output cap · Additional opt-in required'),
          h('label', { className: 'dsh-cache-policy-lifetime' }, h('span', null, t.lifetime),
            h('input', { className: 'dsh-cache-settings-input dsh-cache-policy-minutes', type: 'number', min: 1, max: 10080, step: 1,
              'aria-label': `${t.lifetime} ${identity}`, value: row.cacheMinutes ?? '', placeholder: t.unknown, disabled: locked,
              onChange: event => updateModel(model, { cacheMinutes: event.target.value === '' ? null : Number(event.target.value) }) })),
          h('div', { className: 'dsh-cache-policy-actions' },
            h('label', { className: 'dsh-cache-policy-toggle' }, h('span', null, t.allow),
              h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
                'aria-checked': row.enabled, disabled: locked, 'aria-label': `${t.allow} ${identity}`,
                onClick: () => updateModel(model, { enabled: !row.enabled }) },
              h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
            model.available ? button(t.reset, () => resetModel(model), busy || !draft || (!custom && !(draft.useCodexDefaults === false && model.defaultCacheMinutes != null && rows.length < 100)), `${t.reset} ${identity}`)
              : button(t.remove, () => removeModel(model), busy || !draft, `${t.remove} ${identity}`)));
      };
      return h('section', { className: 'dsh-cache-settings' },
        h('p', { className: 'dsh-cache-settings-description' }, t.description),
        draft ? h(React.Fragment, null,
          h('label', { className: 'dsh-cache-settings-row' }, settingText('autoWarmNewChats', t.defaultEnabled, t.defaultHelp),
            h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
              'aria-checked': draft.autoWarmNewChats, 'aria-label': t.defaultEnabled, disabled: busy,
              'aria-describedby': `${helpId}-autoWarmNewChats`,
              onClick: () => set('autoWarmNewChats', !draft.autoWarmNewChats) }, h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
          field('activeMinutes', t.active, t.activeHelp), field('idleMinutes', t.idle, t.idleHelp),
          h('div', { className: 'dsh-cache-settings-window-note' },
            h('p', null, t.windowHelp), h('p', null, t.windowExample)),
          h('label', { className: 'dsh-cache-settings-row' }, settingText('allowClientBoundWarming', t.clientBound, t.clientBoundHelp),
            h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
              'aria-checked': draft.allowClientBoundWarming, 'aria-label': t.clientBound, disabled: busy,
              'aria-describedby': `${helpId}-allowClientBoundWarming`,
              onClick: () => set('allowClientBoundWarming', !draft.allowClientBoundWarming) }, h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
          h('details', { className: 'dsh-cache-settings-advanced' },
            h('summary', null, t.advanced),
            h('p', { className: 'dsh-cache-policy-note' }, t.costHelp),
            field('minExpectedBenefitUsd', t.benefit, t.benefitHelp, 1000, 0.001),
            field('idleContinuationPercent', t.probability, t.probabilityHelp, 100),
            h('p', { className: 'dsh-cache-policy-note' }, t.codexCostHelp)),
          !validSettings && h('p', { role: 'alert', className: 'dsh-cache-settings-error' }, t.invalidSettings))
          : h('div', { className: 'dsh-cache-policy-note', role: error === 'load' || error === 'load-timeout' ? 'alert' : 'status' },
            error === 'load-timeout' ? t.loadTimeout : error === 'load' ? t.loadError : t.loading,
            (error === 'load' || error === 'load-timeout') && button(t.retry, () => setSettingsRequest(n => n + 1))),
        h('section', { className: 'dsh-cache-policy-section', 'aria-label': t.models },
          h('div', { className: 'dsh-cache-policy-actions' }, h('h3', null, t.models),
            button(t.refresh, () => setModelsRequest(n => n + 1), modelsLoading)),
          h('p', { className: 'dsh-cache-policy-note' }, t.assumption),
          h('p', { className: 'dsh-cache-policy-note' }, t.discovery),
          h('div', { className: 'dsh-cache-policy-grid' },
            h('label', { className: 'dsh-cache-policy-field' }, h('span', null, t.search),
              h('input', { type: 'search', className: 'dsh-cache-policy-input', value: search, 'aria-label': t.search,
                onChange: event => { setSearch(event.target.value); setLimit(25); } })),
            h('label', { className: 'dsh-cache-policy-field' }, h('span', null, t.provider),
              h('select', { className: 'dsh-cache-policy-input', value: providerFilter, 'aria-label': t.provider,
                onChange: event => { setProviderFilter(event.target.value); setLimit(25); } },
              h('option', { value: '' }, t.all), allGroups.map(group => h('option', { key: group.id, value: group.id }, `${group.name} (${group.models.length})`))))),
          modelsLoading && h('p', { className: 'dsh-cache-policy-note', role: 'status' }, t.loading),
          catalog.error && h('p', { className: 'dsh-cache-settings-error', role: 'alert' }, catalog.error === 'model-request-timeout' ? t.modelsTimeout : t.providerError,
            button(t.retry, () => setModelsRequest(n => n + 1), modelsLoading)),
          h('p', { className: 'dsh-cache-policy-note', role: 'status' }, zh ? `显示 ${displayed} / ${matched} 个匹配模型，共 ${total} 个；自定义 ${rows.length} / 100`
            : `Showing ${displayed} of ${matched} matching models · ${total} total · ${rows.length}/100 overrides`),
          h('div', { className: 'dsh-cache-policy-list', tabIndex: 0, 'aria-label': t.models },
          filtered.map(group => (group.visible.length || group.error) && h('section', { key: group.id, className: 'dsh-cache-policy-group', 'aria-label': group.name },
            h('h4', null, `${group.name} (${group.matches.length}/${group.models.length})`),
            group.name !== group.id && h('div', { className: 'dsh-cache-policy-id' }, group.id),
            group.error && h('p', { className: 'dsh-cache-settings-error', role: 'alert' }, group.error === 'model-discovery-timeout' ? t.timeout : t.modelError,
              button(t.retry, () => setModelsRequest(n => n + 1), modelsLoading, `${t.retry} ${group.name}`)),
            group.visible.map(renderModel)))),
          !modelsLoading && !matched && h('p', { className: 'dsh-cache-policy-note' }, t.empty),
          displayed < matched && button(t.more, () => setLimit(n => n + 25)),
          rows.length >= 100 && h('p', { className: 'dsh-cache-policy-note' }, t.limit),
          !validRows && h('p', { role: 'alert', className: 'dsh-cache-settings-error' }, t.invalid)),
        draft && h('div', { className: 'dsh-cache-settings-footer' },
          h('button', { type: 'button', className: 'dsh-cache-settings-save',
            disabled: busy || !valid || JSON.stringify(values) === JSON.stringify(draft), onClick: save }, busy ? t.saving : t.save),
          error === 'save' && h('span', { role: 'alert', className: 'dsh-cache-settings-error' }, t.saveError)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        function BoundCachePill(props) {
          return h(CachePill, { ...props, ctx, key: props.sessionId });
        }
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-cache-warmer-ui';
          style.textContent = `
.dsh-cache-settings{box-sizing:border-box;width:100%;max-width:640px;font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings h2{margin:0 0 8px;font:inherit;font-size:20px;line-height:28px;font-weight:500}
.dsh-cache-settings-description{margin:0 0 12px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsh-cache-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;min-width:0}
.dsh-cache-settings-row+.dsh-cache-settings-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-cache-settings-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dsh-cache-settings-label{min-width:0;font-size:13px;font-weight:500;line-height:20px}
.dsh-cache-settings-help{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsh-cache-settings-window-note{margin:12px 0 16px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-cache-settings-window-note p{margin:0}
.dsh-cache-settings-window-note p+p{margin-top:8px}
.dsh-cache-settings-advanced{margin:12px 0;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}
.dsh-cache-settings-advanced summary{cursor:pointer;font-size:14px;line-height:22px;font-weight:500}
.dsh-cache-settings-advanced summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-cache-settings-input{box-sizing:border-box;width:88px;flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-cache-policy-section{margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:16px}
.dsh-cache-policy-section summary{cursor:pointer;font-weight:500;line-height:24px}
.dsh-cache-policy-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:12px 0;overflow-wrap:anywhere}
.dsh-cache-policy-section h3,.dsh-cache-policy-group h4{margin:0;font:inherit;font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.dsh-cache-policy-group{margin-top:20px;min-width:0}
.dsh-cache-policy-list{max-height:min(60vh,600px);overflow-y:auto;overscroll-behavior:contain;padding:2px;min-width:0}
.dsh-cache-policy-list:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-id,.dsh-cache-policy-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-cache-policy-card>strong{font-size:14px;line-height:22px;font-weight:500}
.dsh-cache-policy-status{margin:4px 0 8px}
.dsh-cache-policy-card{min-width:0;margin:12px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow-wrap:anywhere}
.dsh-cache-policy-card .dsh-cache-policy-actions{margin-top:12px}
.dsh-cache-policy-lifetime{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0;margin-top:12px;font-size:13px;line-height:20px}
.dsh-cache-policy-lifetime>span{min-width:0}
.dsh-cache-policy-minutes{width:96px;max-width:100%;text-align:right}
.dsh-cache-policy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
.dsh-cache-policy-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px;line-height:20px}
.dsh-cache-policy-input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary)}
.dsh-cache-policy-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-actions,.dsh-cache-policy-toggle{display:flex;align-items:center;gap:12px}
.dsh-cache-policy-actions{justify-content:space-between;flex-wrap:wrap}
.dsh-cache-policy-toggle{cursor:pointer}
.dsh-cache-policy-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-button{appearance:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;flex-shrink:0}
.dsh-cache-policy-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-cache-policy-button:disabled{opacity:.45;cursor:default}
@media(max-width:480px){.dsh-cache-policy-grid{grid-template-columns:minmax(0,1fr)}.dsh-cache-policy-input,.dsh-cache-settings-input{font-size:16px}}
.dsh-cache-settings-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-cache-settings-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-cache-settings-save:disabled{opacity:.4;cursor:default}
.dsh-cache-settings-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-settings-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.dsh-cache-settings-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-cache-settings-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-cache-settings-switch:disabled{cursor:default;opacity:.5}
.dsh-cache-settings-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-cache-settings-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-cache-settings-switch[aria-checked=true] .dsh-cache-settings-thumb{transform:translateX(16px)}
@media(prefers-reduced-motion:reduce){.dsh-cache-settings-thumb{transition:none}}

.dsh-cache-warmer-check{appearance:none;box-sizing:border-box;display:inline-grid;place-content:center;width:14px;height:14px;flex:none;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-bg-base);cursor:inherit}
.dsh-cache-warmer-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-cache-warmer-check:checked::after{content:'';width:6px;height:3px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-1px) rotate(-45deg)}
.dsh-cache-warmer-check:disabled{background:var(--dsw-alias-interactive-bg-hover);opacity:.5}
.dsh-cache-warmer-check:focus-visible,.dsh-cache-warmer-anchor button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:720px){.dsh-cache-warmer-anchor{--dsh-cache-pill-inline:4px}}
`;
          document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'cache-warmer', order: 5,
        }, BoundCachePill));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-cache-warmer',
        }, props => props.view === 'summary' ? null : h(SettingsPage, { ctx })));
      },
    };
  },
});
