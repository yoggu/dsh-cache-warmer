window.__ModuleLoader__.load({
  id: 'dsh-cache-warmer',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    const route = '/api/dsh-cache-warmer';
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
        toggle: '保持缓存活跃', status: '上下文缓存', phase: '阶段',
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
        toggle: 'Keep cache warm', status: 'Context cache', phase: 'Phase',
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

    function CachePill({ sessionId, ctx }) {
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
          return undefined;
        }
        let alive = true;
        let inFlight = false;
        let controller;
        const refresh = async () => {
          if (inFlight) return;
          inFlight = true;
          controller = new AbortController();
          try {
            const response = await fetch(`${route}?sessionId=${encodeURIComponent(sessionId)}`, {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
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
        setLoading(true);
        refresh();
        const poll = setInterval(refresh, 15000);
        return () => {
          alive = false;
          clearInterval(poll);
          if (controller) controller.abort();
        };
      }, [sessionId]);

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);
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
      const phase = status && status.phase;
      const stateLabel = status && status.status;
      const phaseLabel = labels[phase] || phase;
      const stateText = labels[stateLabel] || stateLabel;
      const hitTokens = finiteNumber(status && status.lastCacheHitTokens);
      const reason = status && typeof status.reason === 'string' ? status.reason : '';
      const zh = locale.startsWith('zh');
      const reasonTexts = zh ? {
        unsupported: '此线路暂无兼容的保温传输。', 'unknown-lifetime': '此模型未配置缓存有效期；仅供观察。',
        'policy-disabled': '此模型的缓存策略已禁止保温。', 'retention-disabled': '此线路已停用提示缓存保留。',
        'unknown-pricing': '模型价格未知，跳过自动保温。', 'no-cache-evidence': '等待实际请求报告缓存命中。',
        'no-context': '等待新的已完成请求，以获取当前上下文。', disabled: '此会话尚未启用自动保温。',
        'request-in-flight': '实际请求正在进行中；保温将等待请求完成。',
        'request-identity-unavailable': '无法解析当前 Harness 的请求标识；已停用自动保温。',
        'window-ended': '距上次实际请求的保温窗口已结束。', 'insufficient-savings': '预计收益低于 0.05 美元，跳过刷新。',
        'cache-elapsed': '预计缓存有效期已过；等待实际请求。', stopped: '因错误、未命中、取消或上下文变化而停止。',
        'no-storage': '持久化设置或费用记录不可用，已停止保温。',
      } : {};
      const routeReason = reasonTexts[status?.reasonCode] || reason || labels.unsupported;
      const reasonText = reasonTexts[status?.reasonCode] || reason;
      const elapsedText = zh ? '预计有效期已过（不代表缓存已删除）' : 'Estimated lifetime elapsed (not confirmed eviction)';
      const tooltipText = hasExpiry ? (remainingMs > 0 ? labels.ttl : elapsedText)
        : (zh ? '缓存有效期未知' : 'Cache lifetime unknown');
      const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(3)}` : '—';
      const metric = (name, value) => h('div', { key: name, style: rowStyle },
        h('span', { style: mutedStyle }, name), h('span', { style: textStyle }, value));
      const errorText = error === 'save' ? labels.saveFailed : error === 'load' ? labels.failed : '';
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
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            marginBottom: 8, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
            h('span', null, labels.status),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } },
              loading ? labels.loading : !supported ? labels.observationOnly : stateText || labels.unavailable)),
          h('div', { 'aria-hidden': true, style: { borderTop: '.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 } }),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, hasExpiry ? (remainingMs > 0 ? `${labels.ttl}: ${Math.ceil(remainingMs / 60000)} ${labels.minutes}` : elapsedText) : labels.unknown),
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: supported ? 'pointer' : 'not-allowed' },
          },
            h('input', {
              className: 'dsh-cache-warmer-check', type: 'checkbox', checked: enabled,
              disabled: (!supported && !enabled) || saving || !sessionId,
              onChange: (event) => requestEnabled(event.target.checked),
              style: { accentColor: 'var(--dsw-alias-brand-primary)' },
            }),
            h('span', { style: textStyle }, labels.toggle)),
          !supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            routeReason),
          supported && phase != null && h('div', { style: rowStyle },
            h('span', { style: mutedStyle }, labels.phase), h('span', { style: textStyle }, phaseLabel)),
          status?.ruleSource && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            status.ruleSource === 'custom' ? (zh ? '自定义有效期假设' : 'Custom lifetime assumption')
              : status.ruleSource === 'codex-default' ? (zh ? 'Codex 默认估计' : 'Codex estimated default')
              : (zh ? '有效期未知' : 'Lifetime unknown')),
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
          status?.decision?.subscription && h('div', { style: { ...mutedStyle, paddingTop: 8 } },
            zh ? '按 API 等价价格估计，并非订阅配额。保温会消耗用量；Codex 不保证输出令牌上限。'
              : 'API-equivalent estimate, not subscription allowance. Warming consumes usage; Codex has no guaranteed output cap.'),
          reason && supported && h('div', { style: { ...mutedStyle, paddingTop: 8, overflowWrap: 'anywhere' } },
            h('span', { style: textStyle }, `${labels.reason}: `), reasonText),
          errorText && h('div', {
            role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', paddingTop: 8 },
          }, errorText),
        ), document.body));
    }

    function SettingsPage({ ctx, embedded = false }) {
      const [values, setValues] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [defaults, setDefaults] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const providerListId = React.useId();
      const editable = value => ({ autoWarmNewChats: value.autoWarmNewChats, activeMinutes: value.activeMinutes,
        idleMinutes: value.idleMinutes, useCodexDefaults: value.useCodexDefaults !== false, modelPolicies: value.modelPolicies || [] });
      const [error, setError] = React.useState('');
      const [locale, setLocale] = React.useState(() => getLocale(ctx));
      const zh = locale.toLowerCase().startsWith('zh');
      const settingsText = zh ? {
        title: '上下文缓存', description: '按预计收益决定是否保温；会产生 API 费用或消耗订阅用量。两个阶段均从上次实际模型请求开始计时，保温请求不会延长窗口。缓存时间为估计值。阶段设为 0 可停用。',
        defaultEnabled: '默认保持新对话的缓存活跃', active: '运行期间（分钟）', idle: '运行结束后（分钟）',
        loadError: '无法加载设置。', saveError: '保存失败。', save: '保存', saving: '保存中…', loading: '加载中…',
        advanced: '模型缓存策略', builtins: '使用 Codex 默认估计', viewDefaults: '查看 Codex 默认估计',
        customize: '自定义', customized: '已自定义', custom: '自定义假设', add: '添加模型', remove: '移除',
        provider: 'Provider / 线路 ID', model: '精确模型 ID', allow: '允许保温', lifetime: '预计缓存有效期（分钟）', unknown: '未知',
        empty: '暂无自定义规则。OpenRouter 默认仅供观察。',
        assumption: '有效期只是本地调度假设，不会设置提供商的缓存 TTL。空白表示未知，不会自动保温。',
        precedence: '自定义规则会完整替换默认值，包括空白。移除规则后恢复已启用的默认估计。每个对话的开关、缓存证据及收益检查仍然有效。',
        transport: '当前保温传输仅支持 codex-personal、codex-business，以及 OpenRouter 的 ~deepseek/deepseek-v4-flash-latest。其他模型仅供观察；添加规则不会启用传输。',
        defaultNote: '这些是模型系列的估计，不是提供商保证。可用自定义有效期覆盖。',
        invalid: '请输入精确的 Provider / 模型 ID（不含通配符）、1–10080 的整数分钟或空白。最多 100 条，Provider / 模型组合不得重复。',
      } : {
        title: 'Context cache', description: 'Refresh only when estimated benefits justify the cost. Warming consumes API or subscription usage. Both windows start at the last real model request; refreshes never extend them. Cache time is an estimate. Set a phase to 0 to disable it.',
        defaultEnabled: 'Keep new chats warm by default', active: 'During an active run (minutes)', idle: 'After a run ends (minutes)',
        loadError: 'Could not load settings.', saveError: 'Save failed.', save: 'Save', saving: 'Saving …', loading: 'Loading …',
        advanced: 'Model cache policies', builtins: 'Use Codex estimated defaults', viewDefaults: 'View Codex estimated defaults',
        customize: 'Customize', customized: 'Customized', custom: 'Custom assumption', add: 'Add model', remove: 'Remove',
        provider: 'Provider / route ID', model: 'Exact model ID', allow: 'Allow warming', lifetime: 'Estimated cache lifetime (minutes)', unknown: 'Unknown',
        empty: 'No custom rules. OpenRouter is observation-only by default.',
        assumption: 'The lifetime is a local scheduling assumption, not a provider TTL setting. Blank means unknown, with no automatic warming.',
        precedence: 'A custom rule fully replaces its default, including blanks. Removing it restores enabled defaults. Per-chat consent, cache evidence and the savings check still apply.',
        transport: 'Warming transports currently support codex-personal, codex-business, and OpenRouter’s ~deepseek/deepseek-v4-flash-latest only. Other models remain observation-only; adding a rule does not enable a transport.',
        defaultNote: 'Model-family estimates, not provider guarantees. Customize to override the estimated lifetime.',
        invalid: 'Use exact provider/model IDs (no wildcards), integer minutes from 1–10080 or blank. Maximum 100 rows; provider/model pairs must be unique.',
      };
      React.useEffect(() => {
        let active = true;
        fetch(`${route}?scope=settings`, { credentials: 'include' })
          .then(response => { if (!response.ok) throw new Error('settings'); return response.json(); })
          .then(value => { if (active) { const settings = editable(value); setValues(settings); setDraft(settings); setDefaults(value.defaultModelPolicies || []); } })
          .catch(() => { if (active) setError('load'); });
        return () => { active = false; };
      }, []);
      React.useEffect(() => {
        const api = ctx.locale;
        if (!api || typeof api.subscribe !== 'function') return undefined;
        return api.subscribe(() => setLocale(getLocale(ctx)));
      }, []);
      const set = (name, value) => setDraft(previous => ({ ...previous, [name]: value }));
      const save = async () => {
        if (!draft || busy) return;
        setBusy(true); setError('');
        try {
          const response = await fetch(route, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'settings', ...draft }) });
          if (!response.ok) throw new Error('save');
          const result = await response.json();
          const settings = editable(result);
          setDraft(settings); setValues(settings);
          if (Array.isArray(result.defaultModelPolicies)) setDefaults(result.defaultModelPolicies);
        } catch { setError('save'); }
        finally { setBusy(false); }
      };
      const field = (key, title, min = 0, max = 1440, step = 1) => h('label', { className: 'dsh-cache-settings-row' },
        h('span', { className: 'dsh-cache-settings-label' }, title), h('input', { type: 'number', min, max, step,
          className: 'dsh-cache-settings-input', disabled: busy,
          value: draft[key], onChange: event => set(key, event.target.value === '' ? '' : Number(event.target.value)),
        }));
      const rows = draft?.modelPolicies || [];
      const pair = row => JSON.stringify([row.provider, row.model]);
      const validMinutes = n => n === null || (Number.isInteger(n) && n >= 1 && n <= 10080);
      const validRows = rows.length <= 100 && new Set(rows.map(pair)).size === rows.length && rows.every(row =>
        typeof row.provider === 'string' && row.provider.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(row.provider)
        && typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 256 && row.model === row.model.trim()
        && !/[*?\[\]{}]/.test(row.model) && typeof row.enabled === 'boolean' && validMinutes(row.cacheMinutes));
      const valid = draft && validRows && Number.isInteger(draft.activeMinutes) && draft.activeMinutes >= 0 && draft.activeMinutes <= 1440
        && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 0 && draft.idleMinutes <= 1440;
      const updateRow = (index, key, value) => set('modelPolicies', rows.map((row, i) => i === index ? { ...row, [key]: value } : row));
      const addRow = row => { if (!busy && rows.length < 100) set('modelPolicies', [...rows, { ...row }]); };
      const switchControl = (label, checked, onClick) => h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
        'aria-label': label, 'aria-checked': checked, disabled: busy, onClick }, h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }));
      const policyField = (row, index, key, title, numeric = false) => h('label', { className: 'dsh-cache-policy-field' },
        h('span', null, title), h('input', { className: 'dsh-cache-policy-input', type: numeric ? 'number' : 'text', disabled: busy,
          'aria-label': `${title} ${index + 1}`, value: row[key] ?? '',
          ...(numeric ? { min: 1, max: 10080, step: 1, placeholder: settingsText.unknown }
            : { maxLength: key === 'provider' ? 128 : 256, autoComplete: 'off', spellCheck: false,
                ...(key === 'provider' ? { list: providerListId } : {}) }),
          onChange: event => updateRow(index, key, numeric ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value) }));
      return h('section', { className: 'dsh-cache-settings', style: { padding: embedded ? '0' : '20px 24px' } },
        !embedded && h('h2', null, settingsText.title),
        h('p', { className: 'dsh-cache-settings-description' }, settingsText.description),
        draft ? h(React.Fragment, null,
          h('label', { className: 'dsh-cache-settings-row' },
            h('span', { className: 'dsh-cache-settings-label' }, settingsText.defaultEnabled),
            h('button', { type: 'button', role: 'switch', className: 'dsh-cache-settings-switch',
              'aria-checked': draft.autoWarmNewChats, 'aria-label': settingsText.defaultEnabled, disabled: busy,
              onClick: () => set('autoWarmNewChats', !draft.autoWarmNewChats) },
              h('span', { className: 'dsh-cache-settings-thumb', 'aria-hidden': true }))),
          field('activeMinutes', settingsText.active),
          field('idleMinutes', settingsText.idle),
          h('details', { className: 'dsh-cache-policy-section' },
            h('summary', null, settingsText.advanced),
            h('p', { className: 'dsh-cache-policy-note' }, settingsText.assumption),
            h('label', { className: 'dsh-cache-settings-row' }, h('span', { className: 'dsh-cache-settings-label' }, settingsText.builtins),
              switchControl(settingsText.builtins, draft.useCodexDefaults, () => set('useCodexDefaults', !draft.useCodexDefaults))),
            h('details', { className: 'dsh-cache-policy-defaults' },
              h('summary', null, `${settingsText.viewDefaults} (${defaults.length})`),
              h('p', { className: 'dsh-cache-policy-note' }, settingsText.defaultNote),
              defaults.map(row => {
                const exists = rows.some(value => pair(value) === pair(row));
                return h('div', { className: 'dsh-cache-policy-default', key: pair(row) },
                  h('div', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, h('div', null, row.provider), h('strong', null, row.model),
                    h('div', null, row.cacheMinutes == null ? settingsText.unknown : `${row.cacheMinutes} ${zh ? '分钟' : 'min'}`)),
                  h('button', { type: 'button', className: 'dsh-cache-policy-button', disabled: busy || exists || rows.length >= 100,
                    'aria-label': `${settingsText.customize} ${row.provider}/${row.model}`, onClick: () => addRow(row) }, exists ? settingsText.customized : settingsText.customize));
              })),
            h('p', { className: 'dsh-cache-policy-note' }, settingsText.precedence),
            h('datalist', { id: providerListId }, ['openrouter', 'codex-personal', 'codex-business'].map(value => h('option', { key: value, value }))),
            !rows.length && h('p', { className: 'dsh-cache-policy-note' }, settingsText.empty),
            rows.map((row, index) => h('fieldset', { className: 'dsh-cache-policy-card', key: index },
              h('legend', null, `${settingsText.custom} ${index + 1}`),
              h('div', { className: 'dsh-cache-policy-grid' }, policyField(row, index, 'provider', settingsText.provider), policyField(row, index, 'model', settingsText.model)),
              h('div', { style: { marginBottom: 12 } }, policyField(row, index, 'cacheMinutes', settingsText.lifetime, true)),
              h('div', { className: 'dsh-cache-policy-actions' },
                h('label', { className: 'dsh-cache-policy-toggle' }, h('span', null, settingsText.allow),
                  switchControl(`${settingsText.allow} ${index + 1}`, row.enabled, () => updateRow(index, 'enabled', !row.enabled))),
                h('button', { type: 'button', className: 'dsh-cache-policy-button', disabled: busy,
                  'aria-label': `${settingsText.remove} ${index + 1}`, onClick: () => set('modelPolicies', rows.filter((_, i) => i !== index)) }, settingsText.remove)))),
            h('button', { type: 'button', className: 'dsh-cache-policy-button', disabled: busy || rows.length >= 100,
              onClick: () => addRow({ provider: 'openrouter', model: '', enabled: false, cacheMinutes: null }) }, settingsText.add),
            !validRows && h('p', { role: 'alert', className: 'dsh-cache-settings-error' }, settingsText.invalid),
            h('p', { className: 'dsh-cache-policy-note' }, settingsText.transport)),
          h('div', { className: 'dsh-cache-settings-footer' },
            h('button', { type: 'button', className: 'dsh-cache-settings-save',
              disabled: busy || !valid || JSON.stringify(values) === JSON.stringify(draft), onClick: save },
              busy ? settingsText.saving : settingsText.save),
            error && h('span', { role: 'alert', className: 'dsh-cache-settings-error' }, settingsText.saveError)))
          : h('p', { className: 'dsh-cache-settings-description' }, error ? settingsText.loadError : settingsText.loading));
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
.dsh-cache-settings-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5}
.dsh-cache-settings-input{box-sizing:border-box;width:88px;flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-cache-settings-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-cache-policy-section{margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:16px}
.dsh-cache-policy-section summary{cursor:pointer;font-weight:500;line-height:24px}
.dsh-cache-policy-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);margin:12px 0;overflow-wrap:anywhere}
.dsh-cache-policy-defaults{margin-bottom:16px}
.dsh-cache-policy-default{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px}
.dsh-cache-policy-card{min-width:0;margin:16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dsh-cache-policy-card legend{padding:0 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-cache-policy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
.dsh-cache-policy-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px}
.dsh-cache-policy-input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary)}
.dsh-cache-policy-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-policy-actions,.dsh-cache-policy-toggle{display:flex;align-items:center;gap:12px}
.dsh-cache-policy-actions{justify-content:space-between}
.dsh-cache-policy-button{appearance:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;flex-shrink:0}
.dsh-cache-policy-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-cache-policy-button:disabled{opacity:.45;cursor:default}
@media(max-width:480px){.dsh-cache-policy-grid{grid-template-columns:minmax(0,1fr)}.dsh-cache-policy-input{font-size:16px}.dsh-cache-policy-default{align-items:flex-start}}
.dsh-cache-settings-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-cache-settings-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-cache-settings-save:disabled{opacity:.4;cursor:default}
.dsh-cache-settings-save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-cache-settings-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
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
        }, props => props.view === 'summary' ? null : h(SettingsPage, { ctx, embedded: true })));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'context-cache', order: 18,
          label: () => getLocale(ctx).toLowerCase().startsWith('zh') ? '上下文缓存' : 'Context cache',
        }, () => h(SettingsPage, { ctx })));
      },
    };
  },
});
