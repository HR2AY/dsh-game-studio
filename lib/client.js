/**
 * 沙盒游戏工坊（Game Studio）客户端入口。
 *
 * 这是一个已经构建好的单文件模块：只使用模块加载器共享基线里的 React 与
 * react-dom，不依赖任何第三方运行时。
 *
 * 界面结构（customFrame 业务整页）：
 * - 顶栏：文件夹 / 游戏切换、刷新、在浏览器打开、会话区开关。
 * - 主区：游戏卡片墙（未选中）或 localhost 预览 iframe（已选中）。
 * - 右侧：宿主提供的原生会话节点，用于“边聊边改”。
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API_PREFIX = '/_dsh/game-studio/api'
    const EVENTS_PREFIX = '/_dsh/game-studio/events'
    const PET_PREFIX = '/_dsh/game-studio/pet'

    /** IP 宠物三态素材（随包分发，由本工作台服务端只读提供）。 */
    const PET_IMAGES = {
      idle: `${PET_PREFIX}/idle.png`,
      thinking: `${PET_PREFIX}/thinking.gif`,
      running: `${PET_PREFIX}/running.gif`
    }

    /** 需要创建会话时展示的开场描述；由用户自己决定是否发送。 */
    function starterPrompt(game) {
      const name = game?.title || game?.name || '这个游戏'
      return `我要改「${name}」这个网页小游戏。请先读一遍它的 index.html 和 js/css，然后用我看得懂的话告诉我它是怎么跑起来的，并问我最想先改哪一处。`
    }

    /** 当前生效的 token（每次 Harness 启动会换新）。 */
    const tokenBox = { current: '' }

    /**
     * 统一的本机接口请求：自动带上当前 token；遇到 token 过期（403）时，
     * 从错误响应里拿到新 token 并**自动重试一次**。这样调用方永远不必手动处理 token。
     */
    async function api(path, options) {
      const baseUrl = `${API_PREFIX}${path}`
      const withToken = (url) => {
        const separator = url.includes('?') ? '&' : '?'
        return tokenBox.current ? `${url}${separator}token=${encodeURIComponent(tokenBox.current)}` : url
      }
      const send = async (url) => {
        const response = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...options,
          headers: {
            ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options?.headers ?? {})
          }
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        return { response, payload }
      }

      let result = await send(withToken(baseUrl))
      // token 过期：服务端在 403 响应里直接给出当前 token，换新后重试一次。
      if (result.response.status === 403 && typeof result.payload?.token === 'string') {
        tokenBox.current = result.payload.token
        result = await send(withToken(baseUrl))
      }
      if (!result.response.ok) {
        throw new Error(result.payload?.error || `本机接口返回 HTTP ${result.response.status}`)
      }
      if (result.payload?.token) tokenBox.current = result.payload.token
      return result.payload
    }

    function GameCard({ game, onOpen, busy }) {
      return h('button', {
        type: 'button',
        className: 'gs-card',
        disabled: busy,
        onClick: () => onOpen(game)
      },
      h('span', { className: 'gs-card-title' }, game.title || game.name),
      h('span', { className: 'gs-card-name' }, game.name),
      h('span', { className: 'gs-card-go' }, '打开预览 →'))
    }

    function GameList({ games, onOpen, busy }) {
      return h('div', { className: 'gs-list' },
        ...games.map((game) => h(GameCard, { key: game.id, game, onOpen, busy })),
        h('div', { className: 'gs-list-footer' },
          h('span', { className: 'gs-muted' }, `共 ${games.length} 个游戏`),
          h('span', { className: 'gs-muted' }, '选一个卡片，就在 localhost 里把它跑起来')))
    }

    function EmptyState({ rootPath, onPick, recent, onUseRecent, busy, error }) {
      return h('div', { className: 'gs-empty' },
        h('h2', null, rootPath ? '这个文件夹里还没有找到小游戏' : '先选一个游戏文件夹'),
        h('p', { className: 'gs-muted' }, rootPath
          ? '工作台加载的是“自己带 index.html 的文件夹”。把游戏文件夹放进这个目录，或者换一个目录。'
          : '选一个放游戏的文件夹（每个游戏是一个自带 index.html 的文件夹）。工作台会在 localhost 里把它跑起来，你可以一边看一边让 AI 改。'),
        rootPath ? h('p', { className: 'gs-path' }, rootPath) : null,
        error ? h('p', { className: 'gs-error', role: 'alert' }, error) : null,
        h('div', { className: 'gs-row' },
          h('button', {
            type: 'button',
            className: 'gs-btn gs-btn-primary',
            disabled: busy,
            onClick: onPick
          }, busy ? '正在打开选择器…' : rootPath ? '换一个文件夹' : '选择游戏文件夹')),
        recent && recent.length > 0
          ? h('div', { className: 'gs-recent' },
            h('span', { className: 'gs-muted' }, '最近用过：'),
            ...recent.map((item) => h('button', {
              key: item,
              type: 'button',
              className: 'gs-chip',
              disabled: busy,
              title: item,
              onClick: () => onUseRecent(item)
            }, item)))
          : null)
    }

    /**
     * 诊断错误边界：把业务组件的真实异常原文留在面板里。
     *
     * 关键：绝不能在模块求值期依赖 `React.Component` 是个类。共享基线里若没有
     * 这个字段，`class X extends undefined` 会让整个客户端 bundle 注册失败
     * （表现是左侧入口凭空消失）。所以这里退化成普通基类：最坏情况只是这一层
     * 边界不起作用，面板本体照常渲染。
     */
    const BoundaryBase = (() => {
      try {
        return typeof React.Component === 'function' ? React.Component : class {}
      } catch {
        return class {}
      }
    })()

    class DiagnosticBoundary extends BoundaryBase {
      constructor(props) {
        super(props)
        this.state = { message: '', stack: '' }
      }

      static getDerivedStateFromError(error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack || '') : ''
        }
      }

      componentDidCatch(error, info) {
        // 写控制台：开发者工具里能看到完整组件栈。
        console.error('[game-studio] business panel crashed', error, info)
      }

      render() {
        const state = this.state ?? {}
        if (!state.message) return this.props?.children ?? null
        return h(FailureNotice, { message: state.message, stack: state.stack })
      }
    }

    function FailureNotice({ message, stack }) {
      return h('div', { className: 'gs-root' },
        h('style', null, STYLES),
        h('div', { className: 'gs-empty' },
          h('h2', null, '业务面板内部出错了（原文如下）'),
          h('p', { className: 'gs-error', role: 'alert' }, message || '未知错误'),
          stack
            ? h('pre', { className: 'gs-prompt' }, stack.split('\n').slice(0, 6).join('\n'))
            : null,
          h('p', { className: 'gs-muted' }, '把这段原文发给开发者即可定位；公共入口与会话不受影响。')))
    }

function Panel(props) {
  const { service, conversation, entry } = props
  const missing = []
  const hook = (name, value) => {
    if (typeof React?.[name] === 'function') return React[name](value)
    missing.push(name)
    return [value, () => {}]
  }

  // 1. 先取全部状态：即使共享基线缺字段，也要走完所有 hook 调用，顺序保持稳定。
  const [phase, setPhase] = hook('useState', 'loading')
  const [rootPath, setRootPath] = hook('useState', '')
  const [games, setGames] = hook('useState', [])
  const [recent, setRecent] = hook('useState', [])
  const [selected, setSelected] = hook('useState', null)
  const [previewUrl, setPreviewUrl] = hook('useState', '')
  const [showUrl, setShowUrl] = hook('useState', '')
  const [error, setError] = hook('useState', '')
  const [busy, setBusy] = hook('useState', false)
  const [frameKey, setFrameKey] = hook('useState', 0)
  const [frameLoaded, setFrameLoaded] = hook('useState', false)
  const [chatOpen, setChatOpen] = hook('useState', true)
  const [sessionNote, setSessionNote] = hook('useState', '')
  const [renderFailure, setRenderFailure] = hook('useState', null)
  const [previewAuth, setPreviewAuth] = hook('useState', 'unknown')
  // 右侧工具面板：none | paint | mic
  const [sidePanel, setSidePanel] = hook('useState', 'none')
  // 预览列宽度（px），游戏尺寸回报后自动对齐；用户拖拽后以用户为准。
  const [gameColWidth, setGameColWidth] = hook('useState', 520)
  const [gameSize, setGameSize] = hook('useState', null)
  const [userSized, setUserSized] = hook('useState', false)
  // 麦克风面板的转写文本（可编辑）。
  const [micText, setMicText] = hook('useState', '')
  // 画板/麦克风的插入反馈。
  const [insertNote, setInsertNote] = hook('useState', '')
  // IP 宠物状态：AI 正在运行（思考）、游戏文件刚变动（编辑/run）、每秒重算用的计时器。
  const [sessionRunning, setSessionRunning] = hook('useState', false)
  const [lastChangeAt, setLastChangeAt] = hook('useState', 0)
  const [nowTick, setNowTick] = hook('useState', 0)
  const useCallbackHook = (fn) => (typeof React?.useCallback === 'function' ? React.useCallback(fn, []) : fn)
  const useEffectHook = (fn, deps) => {
    if (typeof React?.useEffect === 'function') React.useEffect(fn, deps)
  }

  /** 2. 宿主调用不可信：任何来自 service 的调用都可能抛错，绝不能把异常留在渲染路径上。 */
  const safe = (what, fn, fallback = undefined) => {
    try {
      return fn()
    } catch (cause) {
      console.error(`[game-studio] ${what} threw`, cause)
      return fallback
    }
  }
  const entryId = typeof entry?.id === 'string' ? entry.id : ''
  const sessionProbe = safe('service session probe', () => {
    const sessionId = typeof service?.currentSession === 'function' ? service.currentSession() : undefined
    if (!sessionId) return { sessionId: undefined, owns: false }
    const owns = typeof service?.ownsSession === 'function' ? Boolean(service.ownsSession(sessionId)) : false
    return { sessionId, owns }
  }, { sessionId: undefined, owns: undefined })
  const currentSession = sessionProbe?.sessionId
  const ownsCurrent = sessionProbe?.owns === true

  if (missing.length > 0) {
    return h(FailureNotice, {
      message: `共享基线缺少 React 字段：${missing.join(' / ')}`,
      stack: '面板无法在不完整的 React 基线上挂载。'
    })
  }

      const loadRoot = useCallbackHook(async () => {
        try {
          const data = await api('/root')
          setRootPath(data.rootPath || '')
          setGames(Array.isArray(data.games) ? data.games : [])
          setRecent(Array.isArray(data.recent) ? data.recent : [])
          setError(data.error || '')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setPhase('ready')
        }
      }, [])

      useEffectHook(() => {
        let cancelled = false
        void (async () => {
          // 先 ping（api() 会自动存 token），再把游戏列表拉下来。
          try {
            await api('/ping')
            if (cancelled) return
            await loadRoot()
          } catch {
            if (cancelled) return
            await loadRoot()
          }
        })()
        return () => {
          cancelled = true
        }
      }, [loadRoot])

      /**
       * 预览授权自检：token 会随 Harness 重启失效，而面板里的预览地址是旧的。
       * 只要面板可见（切回工作台模式或刷新页面）就检查一次，失效时状态条会给出修复入口。
       */
      useEffectHook(() => {
        if (!previewUrl) {
          setPreviewAuth('unknown')
          return () => {}
        }
        let cancelled = false
        const check = async () => {
          try {
            const response = await fetch(previewUrl, { credentials: 'same-origin', cache: 'no-store' })
            try {
              await response.body?.cancel?.()
            } catch {
              // 忽略响应体取消失败
            }
            if (cancelled) return
            setPreviewAuth(response.ok ? 'ok' : 'stale')
          } catch {
            if (!cancelled) setPreviewAuth('stale')
          }
        }
        void check()
        const onVisible = () => {
          if (document.visibilityState === 'visible') void check()
        }
        document.addEventListener?.('visibilitychange', onVisible)
        return () => {
          cancelled = true
          document.removeEventListener?.('visibilitychange', onVisible)
        }
      }, [previewUrl])

      const refreshGames = useCallbackHook(async () => {
        try {
          const data = await api('/games')
          if (typeof data.rootPath === 'string' && data.rootPath) setRootPath(data.rootPath)
          setGames(Array.isArray(data.games) ? data.games : [])
          setRecent(Array.isArray(data.recent) ? data.recent : [])
          setError(data.error || '')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      // 游戏 iframe 回传自身画布/视口尺寸：预览列自动对齐到游戏默认宽度。
      useEffectHook(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (!data || data.__gameStudioSize !== true) return
          const width = Number(data.width)
          const height = Number(data.height)
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
          if (!userSized) setGameColWidth(Math.min(1200, Math.max(220, Math.round(width))))
          setGameSize({ width, height })
        }
        window.addEventListener?.('message', onMessage)
        return () => window.removeEventListener?.('message', onMessage)
      }, [userSized])

      // 输入框里宿主会话区的「画板」图标点一下，就召出右侧画板。
      useEffectHook(() => {
        const onToggle = () => setSidePanel((current) => (current === 'paint' ? 'none' : 'paint'))
        window.addEventListener?.('game-studio:toggle-paint', onToggle)
        return () => window.removeEventListener?.('game-studio:toggle-paint', onToggle)
      }, [])

      // IP 宠物：轮询「AI 是否正在运行」，并每秒重算一次状态（让"编辑/run"会自然衰减）。
      useEffectHook(() => {
        let stopped = false
        const readRunning = () => {
          try {
            const rootCtx = service?.ctx
            const binding = rootCtx?.sessions?.binding?.(currentSession)
            const snapshot = binding?.session?.getSnapshot?.()
            if (!stopped) setSessionRunning(snapshot?.running === true)
          } catch {
            // 读不到运行态就当作空闲，不影响其他功能。
          }
        }
        readRunning()
        const timer = typeof setInterval === 'function'
          ? setInterval(() => {
            readRunning()
            setNowTick((value) => value + 1)
          }, 1000)
          : undefined
        return () => {
          stopped = true
          if (timer !== undefined) clearInterval(timer)
        }
      }, [currentSession, service])

      // IP 宠物：订阅游戏目录的改动事件，用于"编辑/run"状态。
      useEffectHook(() => {
        if (!previewUrl || !selected) return () => {}
        const token = tokenBox.current
        const url = `${EVENTS_PREFIX}/${encodeURIComponent(selected.id)}?token=${encodeURIComponent(token)}`
        let source
        try {
          source = new EventSource(url)
        } catch {
          return () => {}
        }
        const onChange = () => setLastChangeAt(Date.now())
        source.addEventListener('reload', onChange)
        return () => {
          source.removeEventListener?.('reload', onChange)
          source.close()
        }
      }, [previewUrl, selected?.id])

      // 把画板 PNG 插入当前会话：上传 → 取附件 id → 追加到会话草稿附件。
      const insertImage = useCallbackHook(async (dataUrl) => {
        setInsertNote('')
        try {
          if (!currentSession) throw new Error('还没有工作台会话，无法放入对话。请先开一个会话。')
          const rootCtx = service?.ctx
          const remoteUpload = rootCtx?.remote?.fileUploads?.upload
          if (typeof remoteUpload !== 'function') throw new Error('宿主没有提供文件上传接口。')
          const base64 = String(dataUrl).includes(',') ? String(dataUrl).split(',')[1] : String(dataUrl)
          const result = await remoteUpload(currentSession, { data: base64, name: `画板-${Date.now()}.png` }, undefined)
          const attachmentId = result?.file?.attachmentId
          if (!attachmentId) throw new Error('上传没有返回附件标识。')
          const actx = rootCtx?.sessions?.scope?.(currentSession)
          const input = actx?.get?.('conversation')?.input
          if (!input || typeof input.for !== 'function') throw new Error('宿主没有提供会话输入接口。')
          const added = input.for(actx).addAttachments([attachmentId])
          if (added === false) throw new Error('会话正在发送中，稍后再试。')
          setInsertNote('已放入对话（作为附件）。')
        } catch (cause) {
          setInsertNote(`放入对话失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }, [currentSession, service])

      // 把文本写入当前会话草稿（用户仍可编辑后再发送）。
      const insertText = useCallbackHook(async (text) => {
        setInsertNote('')
        try {
          const clean = String(text ?? '').trim()
          if (!clean) {
            setInsertNote('没有可放入的内容。')
            return
          }
          if (!currentSession) throw new Error('还没有工作台会话，无法放入对话。请先开一个会话。')
          const rootCtx = service?.ctx
          const actx = rootCtx?.sessions?.scope?.(currentSession)
          const input = actx?.get?.('conversation')?.input
          if (!input || typeof input.for !== 'function') throw new Error('宿主没有提供会话输入接口。')
          input.for(actx).setDraft(clean)
          setInsertNote('已放入对话草稿，可继续编辑后发送。')
        } catch (cause) {
          setInsertNote(`放入对话失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }, [currentSession, service])


      const setRoot = useCallbackHook(async (path) => {
        setBusy(true)
        try {
          const data = await api('/root', { method: 'POST', body: JSON.stringify({ path }) })
          setRootPath(data.rootPath || path)
          setGames(Array.isArray(data.games) ? data.games : [])
          setRecent(Array.isArray(data.recent) ? data.recent : [])
          setError('')
          setSelected(null)
          setPreviewUrl('')
          setShowUrl('')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [])

      const pickFolder = useCallbackHook(async () => {
        setBusy(true)
        setError('')
        try {
          const path = await Panel.pickDirectory()
          if (path === null || path === undefined || path === '') return
          await setRoot(path)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [setRoot])

      /**
       * 打开游戏。
       *
       * token 是 Harness 每次启动新生成的：面板里已经建好的预览地址在重启后就会 403。
       * 所以这里不信任手上的 token —— 先跟后端对一次，再**用真请求自检**预览地址，
       * 只在确认可用之后才让 iframe 去加载。这样界面上不会再出现"授权已失效"。
       */
      const openGame = useCallbackHook(async (game) => {
        setBusy(true)
        setError('')
        try {
          /** 取最新 token → 打开游戏（后端在此登记预览作用域）→ 真请求自检预览地址。 */
          const attempt = async () => {
            const root = await api('/root')
            const data = await api(`/games/one?gameId=${encodeURIComponent(game.id)}`)
            // token 放路径段里，游戏 HTML 的相对资源会自动继承它。
            const url = `${data.previewPath}${encodeURIComponent(tokenBox.current)}/`
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            return { root, data, url, response }
          }

          let result = await attempt()
          if (!result.response.ok) result = await attempt()
          if (!result.response.ok) {
            throw new Error(`预览打不开（HTTP ${result.response.status}）。请点状态条上的「刷新预览授权」重试。`)
          }

          if (result.root.rootPath && result.root.rootPath !== rootPath) setRootPath(result.root.rootPath)
          if (Array.isArray(result.root.games) && result.root.games.length > 0) setGames(result.root.games)
          setSelected(result.data.game || game)
          setFrameLoaded(false)
          setFrameKey((value) => value + 1)
          setPreviewUrl(result.url)
          setShowUrl(`${window.location.origin}${result.data.previewPath}${encodeURIComponent(tokenBox.current)}/`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [rootPath])

      const startSession = useCallbackHook(async () => {
        setBusy(true)
        setSessionNote('')
        try {
          if (!rootPath) throw new Error('请先选择游戏文件夹')
          const workspace = service?.ctx?.remote?.workspace
          const uiWorkspace = service?.ctx?.uiWorkspace
          if (!workspace?.create) throw new Error('这台 Desktop 没有提供工作区创建能力')
          if (!uiWorkspace?.connectWorkspace) throw new Error('这台 Desktop 没有提供工作区连接能力')
          const created = await workspace.create({ path: rootPath })
          const workspaceId = created?.workspace?.workspaceId
            ?? created?.value?.workspace?.workspaceId
            ?? created?.workspaceId
          if (!workspaceId) throw new Error('工作区创建没有返回标识')
          await uiWorkspace.connectWorkspace(workspaceId)
          // 绑定是宿主异步写入的：稍后再看一次，避免界面一直显示"还没有工作台会话"。
          setSessionNote('工作台会话已创建，正在确认归属…')
          await new Promise((resolve) => setTimeout(resolve, 1200))
          const bound = safe('service session probe', () => {
            const sessionId = typeof service?.currentSession === 'function' ? service.currentSession() : undefined
            return Boolean(sessionId) && (typeof service?.ownsSession === 'function' ? Boolean(service.ownsSession(sessionId)) : false)
          }, false)
          setSessionNote(bound
            ? '已经为这个文件夹开好工作台会话。把下面这段话发出去，就能开始“边聊边改”。'
            : '会话已创建。如果下面仍显示未绑定，请在左侧模式里确认当前是「沙盒游戏工坊」，再点这里重试。')
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setSessionNote(`没能自动开好会话：${message}。可以先在左侧手动新建一个会话，再回到这里重试。`)
        } finally {
          setBusy(false)
        }
      }, [rootPath, service])

      const state = {
        phase,
        rootPath,
        games,
        recent,
        selected,
        previewUrl,
        showUrl,
        error,
        busy,
        frameKey,
        frameLoaded,
        chatOpen,
        sessionNote,
        ownsCurrent,
        conversation,
        previewAuth,
        sidePanel,
        gameColWidth,
        gameSize,
        userSized,
        micText,
        insertNote,
        // IP 宠物状态：'running'（刚有文件变动/编辑·run）> 'thinking'（AI 运行中）> 'idle'
        petState: (lastChangeAt > 0 && Date.now() - lastChangeAt < 6000)
          ? 'running'
          : (sessionRunning ? 'thinking' : 'idle'),
        onOpenGame: (game) => void openGame(game),
        onRefresh: () => void refreshGames(),
        onPickFolder: () => void pickFolder(),
        onUseRecent: (path) => void setRoot(path),
        onBack: () => {
          setSelected(null)
          setPreviewUrl('')
          setShowUrl('')
        },
        onReloadFrame: () => {
          setFrameLoaded(false)
          setFrameKey((value) => value + 1)
        },
        onToggleChat: () => setChatOpen((value) => !value),
        onStartSession: () => void startSession(),
        onFrameLoaded: () => setFrameLoaded(true),
        onToggleSidePanel: (panel) => setSidePanel((current) => (current === panel ? 'none' : panel)),
        onSetMicText: (text) => setMicText(text),
        onInsertImage: (dataUrl) => void insertImage(dataUrl),
        onInsertText: (text) => void insertText(text),
        onGameColWidth: (width) => {
          setUserSized(true)
          setGameColWidth(Math.min(1200, Math.max(220, Math.round(width))))
        },
        // 预览授权失效（Harness 重启后 token 过期）时的自愈入口。
        onRetryPreview: () => {
          setPreviewAuth('unknown')
          if (selected) void openGame(selected)
        }
      }

      if (renderFailure !== null) {
        return h(FailureNotice, { message: renderFailure.message, stack: renderFailure.stack })
      }

      try {
        return PanelView(state)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const stack = cause instanceof Error ? String(cause.stack || '') : ''
        console.error('[game-studio] panel view threw', cause)
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(() => setRenderFailure({ message, stack }))
        }
        return h(FailureNotice, { message, stack })
      }
    }

    /**
     * 画板：基础 Windows 画图能力（画笔、橡皮、颜色、粗细、清空），
     * 【放入对话】把画布导出为 PNG 并作为附件插入当前会话。
     */
    function PaintPanel({ onInsertImage, insertNote, busy }) {
      const canvasRef = React.useRef(null)
      const [color, setColor] = React.useState('#1f6feb')
      const [size, setSize] = React.useState(4)
      const [eraser, setEraser] = React.useState(false)
      const drawing = React.useRef(false)

      const COLORS = ['#1f6feb', '#e23d3d', '#2fbf71', '#f0b429', '#111111', '#ffffff']

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
      }, [])

      const point = (event) => {
        const canvas = canvasRef.current
        const rect = canvas.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      const start = (event) => {
        drawing.current = true
        const ctx = canvasRef.current?.getContext('2d')
        const p = point(event)
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
      }
      const move = (event) => {
        if (!drawing.current) return
        const ctx = canvasRef.current?.getContext('2d')
        const p = point(event)
        ctx.strokeStyle = eraser ? '#ffffff' : color
        ctx.lineWidth = eraser ? size * 3 : size
        ctx.lineTo(p.x, p.y)
        ctx.stroke()
      }
      const end = () => { drawing.current = false }

      const clear = () => {
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      const putInChat = () => {
        const canvas = canvasRef.current
        if (!canvas) return
        onInsertImage?.(canvas.toDataURL('image/png'))
      }

      return h('div', { className: 'gs-paint' },
        h('div', { className: 'gs-paint-tools' },
          ...COLORS.map((c) => h('button', {
            key: c,
            type: 'button',
            className: 'gs-swatch' + (color === c && !eraser ? ' gs-swatch-on' : ''),
            style: { background: c },
            title: c,
            onClick: () => { setEraser(false); setColor(c) }
          })),
          h('button', {
            type: 'button',
            className: 'gs-btn' + (eraser ? ' gs-btn-on' : ''),
            onClick: () => setEraser((v) => !v)
          }, eraser ? '橡皮：开' : '橡皮'),
          h('select', {
            className: 'gs-select',
            value: size,
            'aria-label': '粗细',
            onChange: (event) => setSize(Number(event.target.value))
          },
          h('option', { value: 2 }, '细'),
          h('option', { value: 4 }, '中'),
          h('option', { value: 8 }, '粗')),
          h('button', { type: 'button', className: 'gs-btn', onClick: clear }, '清空')),
        h('canvas', {
          ref: canvasRef,
          className: 'gs-paint-canvas',
          width: 640,
          height: 480,
          onMouseDown: start,
          onMouseMove: move,
          onMouseUp: end,
          onMouseLeave: end
        }),
        h('div', { className: 'gs-paint-actions' },
          h('button', {
            type: 'button',
            className: 'gs-btn gs-btn-primary',
            disabled: busy,
            onClick: putInChat
          }, '放入对话（PNG）'),
          insertNote ? h('span', { className: 'gs-hint', role: 'status' }, insertNote) : null))
    }

    /**
     * 麦克风面板：显示转写文本、可编辑，并可放入对话。
     * 语音采集/转写由 DSH 语音插件完成（待接入），这里先承载"可编辑文本"这一层。
     */
    function MicPanel({ text, onText, onInsertText, insertNote, busy }) {
      return h('div', { className: 'gs-mic' },
        h('textarea', {
          className: 'gs-mic-text',
          value: text,
          placeholder: '这里显示语音转写的内容，可以直接编辑。',
          onChange: (event) => onText?.(event.target.value)
        }),
        h('div', { className: 'gs-paint-actions' },
          h('button', {
            type: 'button',
            className: 'gs-btn gs-btn-primary',
            disabled: busy || !String(text ?? '').trim(),
            onClick: () => onInsertText?.(text)
          }, '放入对话'),
          insertNote ? h('span', { className: 'gs-hint', role: 'status' }, insertNote) : null))
    }

    /**
     * 面板视图（纯函数）：只根据传入状态产出元素树，不碰 hooks 与副作用。
     * 抽出来是为了能用最小的 h() 替身直接断言"界面里出现了什么"。
     */
    function PanelView(state) {
      const {
        phase, rootPath, games, recent, selected, previewUrl, showUrl, error, busy,
        frameKey, frameLoaded, chatOpen, sessionNote, ownsCurrent, conversation,
        previewAuth = 'unknown', sidePanel = 'none', gameColWidth = 520, gameSize = null,
        micText = '', insertNote = '', petState = 'idle'
      } = state

      const toolbar = h('header', { className: 'gs-toolbar' },
        h('div', { className: 'gs-toolbar-main' },
          h('span', { className: 'gs-brand' }, '沙盒游戏工坊'),
          selected
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                className: 'gs-btn gs-btn-ghost',
                onClick: state.onBack
              }, '← 游戏列表'),
              h('span', { className: 'gs-title', title: selected.path }, selected.title || selected.name))
            : h('span', { className: 'gs-muted', title: rootPath }, rootPath || '未选择文件夹')),
        h('div', { className: 'gs-toolbar-actions' },
          selected
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                className: 'gs-btn',
                onClick: state.onReloadFrame
              }, '重新加载'),
              h('a', {
                className: 'gs-btn gs-btn-ghost',
                href: previewUrl || '#',
                target: '_blank',
                rel: 'noopener noreferrer'
              }, '在浏览器打开'))
            : null,
          h('button', {
            type: 'button',
            className: 'gs-btn',
            disabled: busy,
            onClick: state.onRefresh
          }, '刷新列表'),
          h('button', {
            type: 'button',
            className: 'gs-btn',
            disabled: busy,
            onClick: state.onPickFolder
          }, '换文件夹'),
          h('button', {
            type: 'button',
            className: 'gs-btn' + (chatOpen ? ' gs-btn-on' : ''),
            'aria-pressed': chatOpen,
            onClick: state.onToggleChat
          }, chatOpen ? '收起对话' : '边聊边改')))

      const gameBody = (() => {
        if (selected && previewUrl && previewAuth === 'stale') {
          return h('div', { className: 'gs-empty' },
            h('h2', null, '预览授权已失效'),
            h('p', { className: 'gs-muted' }, 'Harness 重启会换掉预览授权。点下面的按钮，工作台会重新取一次授权并重开这个游戏 —— 不用重启，也不用重新选文件夹。'),
            h('div', { className: 'gs-row' },
              h('button', {
                type: 'button',
                className: 'gs-btn gs-btn-primary',
                disabled: busy,
                onClick: state.onRetryPreview
              }, busy ? '正在重开…' : '重新授权并打开')),
            h('p', { className: 'gs-muted', title: showUrl }, showUrl ? `地址：${showUrl}` : ''))
        }
        if (selected && previewUrl) {
          return h('div', { className: 'gs-stage' },
            h('iframe', {
              key: frameKey,
              className: 'gs-frame',
              title: `预览：${selected.title || selected.name}`,
              src: previewUrl,
              sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups allow-modals',
              onLoad: state.onFrameLoaded
            }),
            !frameLoaded ? h('div', { className: 'gs-frame-loading' }, '正在把游戏加载到 localhost…') : null)
        }
        if (phase === 'loading') {
          return h('div', { className: 'gs-empty' }, h('p', { className: 'gs-muted' }, '正在读取工作台状态…'))
        }
        if (Array.isArray(games) && games.length > 0) {
          return h(GameList, { games, onOpen: state.onOpenGame, busy })
        }
        return h(EmptyState, {
          rootPath,
          recent,
          busy,
          error,
          onPick: state.onPickFolder,
          onUseRecent: state.onUseRecent
        })
      })()

      const statusBar = h('div', { className: 'gs-status' },
        h('span', { className: 'gs-dot' + (previewAuth === 'stale' ? ' gs-dot-off' : ''), 'aria-hidden': true }),
        h('span', null, previewAuth === 'stale' ? '预览授权已失效' : 'localhost 实时预览'),
        showUrl ? h('code', { className: 'gs-url', title: showUrl }, showUrl) : null,
        h('span', { className: 'gs-muted' }, previewAuth === 'stale'
          ? '点右边按钮重新授权，不用重启'
          : '纯静态游戏：本地静态服务已在运行，保存后自动刷新'),
        selected?.fromZip
          ? h('span', { className: 'gs-chip', title: `来自游戏包 ${selected.fromZip}` }, `游戏包 · ${selected.fromZip}`)
          : null,
        gameSize ? h('span', { className: 'gs-muted' }, `游戏尺寸 ${gameSize.width}×${gameSize.height}`) : null,
        h('button', {
          type: 'button',
          className: 'gs-btn gs-btn-ghost',
          disabled: busy,
          title: '重启 Harness 后预览授权会过期；点这里重新取一次并重开预览',
          onClick: state.onRetryPreview
        }, '刷新预览授权'))

      // 拖动分隔条调整预览列宽度。
      const beginResize = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startW = gameColWidth
        const move = (e) => state.onGameColWidth?.(startW + (e.clientX - startX))
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }

      const chatColumn = h('aside', {
        className: 'gs-chat',
        hidden: !chatOpen,
        'aria-label': '游戏修改对话'
      },
      h('div', { className: 'gs-chat-head' },
        h('strong', null, '边聊边改'),
        h('span', { className: 'gs-muted' }, ownsCurrent ? '本工作台会话' : '还没有工作台会话')),
      h('div', { className: 'gs-chat-note' },
        !previewUrl
          ? h('p', { className: 'gs-muted' }, '先打开一个游戏，再来聊怎么改。')
          : ownsCurrent
            ? h('p', { className: 'gs-muted' }, '预览会跟着 AI 的修改自动刷新。')
            : h('div', { className: 'gs-note-stack' },
              h('p', { className: 'gs-muted' }, '改游戏需要一个和这个文件夹绑定的工作台会话。'),
              h('button', {
                type: 'button',
                className: 'gs-btn gs-btn-primary',
                disabled: busy,
                onClick: state.onStartSession
              }, busy ? '正在准备…' : '为这个游戏开一个工作台会话'),
              sessionNote ? h('p', { className: 'gs-hint' }, sessionNote) : null,
              selected ? h('code', { className: 'gs-prompt' }, starterPrompt(selected)) : null)),
      h('div', { className: 'gs-chat-body' }, conversation || null))

      const sideColumn = sidePanel === 'none'
        ? null
        : h('aside', {
          className: 'gs-side',
          'aria-label': sidePanel === 'paint' ? '画板' : '麦克风'
        },
        h('div', { className: 'gs-side-head' },
          h('strong', null, sidePanel === 'paint' ? '画板' : '麦克风'),
          h('button', {
            type: 'button',
            className: 'gs-btn gs-btn-ghost',
            title: '关闭',
            onClick: () => state.onToggleSidePanel?.(sidePanel)
          }, '✕')),
        h('div', { className: 'gs-side-body' },
          sidePanel === 'paint'
            ? h(PaintPanel, { onInsertImage: state.onInsertImage, insertNote, busy })
            : h(MicPanel, { text: micText, onText: state.onSetMicText, onInsertText: state.onInsertText, insertNote, busy })))

      return h('div', { className: 'gs-root' },
        h('style', null, STYLES),
        toolbar,
        h('div', { className: 'gs-body' },
          h('section', {
            className: 'gs-col-game',
            style: { flexBasis: `${gameColWidth}px`, width: `${gameColWidth}px` }
          },
          gameBody,
          error && games.length > 0 ? h('p', { className: 'gs-error gs-inline-error', role: 'alert' }, error) : null,
          statusBar),
          h('div', {
            className: 'gs-resizer',
            role: 'separator',
            'aria-orientation': 'vertical',
            title: '拖动调整游戏画面宽度',
            onMouseDown: beginResize
          }),
          chatColumn,
          sideColumn,
          // 右下角 IP 宠物：空闲 / 思考（AI 运行中） / 运行（编辑·run），动图循环播放。
          h('div', {
            className: 'gs-pet',
            'data-state': petState,
            title: petState === 'running' ? '运行中（编辑/run）' : petState === 'thinking' ? '思考中' : '空闲',
            'aria-label': `IP 宠物：${petState === 'running' ? '运行中' : petState === 'thinking' ? '思考中' : '空闲'}`
          },
          h('img', {
            className: 'gs-pet-img',
            src: PET_IMAGES[petState] || PET_IMAGES.idle,
            alt: '',
            draggable: false
          }))))
    }

    /** 面板样式：全部走工作台自己的 gs- 前缀，避免影响宿主。 */
    const STYLES = `
.gs-root{
  /* 黑-橙-白：与 IP 宠物同一套色。橙是唯一强调色，白做前景，黑做底。 */
  --gs-bg:#131110;
  --gs-surface:#1b1815;
  --gs-surface-2:#241f1a;
  --gs-stage:#0d0b0a;
  --gs-border:#3a322b;
  --gs-text:#f7f3ef;
  --gs-muted:#c8bcb1;
  --gs-accent:#ff7a1a;
  --gs-accent-strong:#e2630a;
  --gs-accent-soft:rgba(255,122,26,.16);
  --gs-on-accent:#1a1206;
  --gs-hover:rgba(255,122,26,.10);
  --gs-danger:#ff6b57;
  display:flex;flex-direction:column;height:100%;min-height:0;width:100%;max-width:100%;box-sizing:border-box;
  font-size:13px;color:var(--gs-text);background:var(--gs-bg)}
.gs-root *{box-sizing:border-box}
/* 浏览器自带的表面也归这套配色：选区、插入光标、滚动条、焦点环。 */
.gs-root ::selection{background:var(--gs-accent-soft);color:var(--gs-text)}
.gs-root *{caret-color:var(--gs-accent)}
.gs-root *:focus-visible{outline:2px solid var(--gs-accent);outline-offset:2px;border-radius:4px}
.gs-root *::-webkit-scrollbar{width:10px;height:10px}
.gs-root *::-webkit-scrollbar-track{background:var(--gs-surface-2)}
.gs-root *::-webkit-scrollbar-thumb{background:#4a4038;border-radius:6px;border:2px solid var(--gs-surface-2)}
.gs-root *::-webkit-scrollbar-thumb:hover{background:var(--gs-accent-strong)}
.gs-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;
  padding:8px 12px;min-height:48px;border-bottom:1px solid var(--gs-border);
  background:var(--gs-surface);
  box-shadow:0 5px 14px -10px rgba(0,0,0,.7);
  padding-inline-start:calc(12px + var(--dsh-frame-leading-clearance,0px))}
.gs-toolbar-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 220px}
.gs-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gs-brand{font-weight:600;white-space:nowrap}
.gs-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.gs-muted{color:var(--gs-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-body{display:flex;flex:1 1 auto;min-height:0;position:relative}
.gs-col-game{display:flex;flex-direction:column;flex:0 0 auto;min-width:220px;max-width:100%;min-height:0;
  overflow:hidden;border-inline-end:1px solid var(--gs-border)}
.gs-resizer{flex:0 0 6px;cursor:col-resize;background:transparent;min-height:0}
.gs-resizer:hover{background:var(--gs-accent-soft)}
.gs-business{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}
.gs-stage{position:relative;flex:1 1 auto;min-height:0;background:var(--gs-stage)}
.gs-frame{width:100%;height:100%;border:0;display:block;background:#fff}
.gs-frame-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:var(--gs-on-accent);background:rgba(20,22,26,.72);font-size:14px}
.gs-status{display:flex;align-items:center;gap:8px;padding:6px 12px;flex-wrap:wrap;
  border-top:1px solid var(--gs-border);font-size:12px}
.gs-dot{width:8px;height:8px;border-radius:50%;background:var(--gs-accent);flex:0 0 auto}
.gs-dot-off{background:var(--gs-danger)}
.gs-url{font-family:ui-monospace,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;max-width:46ch;color:var(--gs-muted)}
.gs-inline-error{padding:6px 12px;margin:0}
.gs-chat{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;
  background:var(--gs-surface)}
.gs-chat[hidden]{display:none}
.gs-chat-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
  border-bottom:1px solid var(--gs-border);font-size:12px}
.gs-chat-head strong{flex:1 1 auto}
.gs-chat-tools{display:flex;gap:6px;align-items:center}
.gs-icon-btn{appearance:none;border:1px solid transparent;border-radius:6px;background:transparent;
  width:28px;height:28px;font-size:16px;line-height:1;cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center}
.gs-icon-btn:hover{background:var(--gs-hover)}
.gs-icon-btn-on{border-color:var(--gs-accent);background:var(--gs-accent-soft)}
.gs-composer-icon{appearance:none;border:1px solid transparent;border-radius:6px;background:transparent;
  width:28px;height:28px;font-size:16px;line-height:1;cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center;color:inherit}
.gs-composer-icon:hover{background:var(--gs-hover)}
.gs-chat-note{padding:8px 10px;font-size:12px}
.gs-note-stack{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.gs-chat-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.gs-side{display:flex;flex-direction:column;flex:0 0 clamp(300px,30%,460px);min-width:0;min-height:0;
  border-inline-start:1px solid var(--gs-border);
  background:var(--gs-surface)}
.gs-side-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
  border-bottom:1px solid var(--gs-border);font-size:12px}
.gs-side-head strong{flex:1 1 auto}
.gs-side-body{flex:1 1 auto;min-height:0;overflow:hidden}
.gs-paint{display:flex;flex-direction:column;height:100%;min-height:0;padding:8px;gap:8px}
.gs-paint-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.gs-swatch{appearance:none;width:20px;height:20px;border-radius:50%;border:1px solid rgba(127,127,127,.5);
  cursor:pointer;padding:0}
.gs-swatch-on{outline:2px solid var(--gs-accent);outline-offset:2px}
.gs-select{appearance:auto;border:1px solid var(--gs-border);border-radius:6px;
  padding:3px 6px;font-size:12px;background:transparent;color:inherit;min-height:28px}
.gs-paint-canvas{flex:1 1 auto;min-height:0;width:100%;background:#fff;border:1px solid var(--gs-border);
  border-radius:6px;cursor:crosshair;touch-action:none;image-rendering:auto}
.gs-paint-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gs-mic{display:flex;flex-direction:column;height:100%;min-height:0;padding:8px;gap:8px}
.gs-mic-text{flex:1 1 auto;min-height:0;width:100%;resize:none;border:1px solid var(--gs-border);
  border-radius:10px;padding:10px;font-size:13px;line-height:1.6;background:var(--gs-surface-2);
  color:var(--gs-text);box-sizing:border-box;font-family:inherit}
.gs-mic-text::placeholder{color:var(--gs-muted);opacity:1}
.gs-pet{position:absolute;right:18px;bottom:18px;width:144px;height:144px;border-radius:18px;
  display:flex;align-items:flex-end;justify-content:center;overflow:hidden;
  pointer-events:none;z-index:5}
.gs-pet-img{width:100%;height:100%;object-fit:contain;object-position:bottom;display:block;
  image-rendering:auto;user-select:none;-webkit-user-drag:none;
  filter:drop-shadow(0 10px 18px rgba(0,0,0,.55))}
.gs-pet[data-state='thinking'] .gs-pet-img{animation:gs-pet-breathe 2.4s ease-in-out infinite}
.gs-pet[data-state='running'] .gs-pet-img{animation:gs-pet-lift 1.6s cubic-bezier(.16,1,.3,1) infinite}
@keyframes gs-pet-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.02)}}
@keyframes gs-pet-lift{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@media (prefers-reduced-motion: reduce){
  .gs-pet[data-state='thinking'] .gs-pet-img,.gs-pet[data-state='running'] .gs-pet-img{animation:none}
}
.gs-hint{margin:0;font-size:12px;line-height:1.5;color:var(--gs-muted);
  white-space:normal;word-break:break-word}
.gs-prompt{display:block;padding:8px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;
  background:var(--gs-surface-2);word-break:break-word;max-width:100%}
.gs-btn{appearance:none;border:1px solid var(--gs-border);border-radius:6px;
  padding:5px 10px;font-size:12px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;
  text-decoration:none;display:inline-flex;align-items:center;min-height:28px}
.gs-btn:hover:not([disabled]){background:var(--gs-hover);border-color:var(--gs-accent)}
.gs-btn[disabled]{opacity:.55;cursor:default}
.gs-btn-primary{background:var(--gs-accent);border-color:var(--gs-accent);color:var(--gs-on-accent);
  font-weight:600;box-shadow:0 6px 14px -8px rgba(255,122,26,.65)}
.gs-btn-primary:hover:not([disabled]){background:var(--gs-accent-strong);border-color:var(--gs-accent-strong)}
.gs-btn-on{border-color:var(--gs-accent);color:var(--gs-accent);background:var(--gs-accent-soft)}
.gs-btn-ghost{border-color:transparent}
.gs-empty{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;align-items:flex-start;
  justify-content:center;padding:24px;max-width:720px;overflow:auto}
.gs-empty h2{margin:0 0 2px;font-size:17px;font-weight:650;letter-spacing:-.01em}
.gs-empty p{margin:0;line-height:1.6;color:var(--gs-muted)}
.gs-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;white-space:normal;
  color:var(--gs-muted)}
.gs-error{color:var(--gs-danger);white-space:normal}
.gs-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gs-recent{display:flex;gap:6px;flex-wrap:wrap;align-items:center;max-width:100%}
.gs-chip{max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;appearance:none;
  border:1px solid var(--gs-border);border-radius:999px;padding:3px 10px;
  font-size:12px;background:transparent;color:inherit;cursor:pointer}
.gs-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;
  padding:14px;overflow:auto;align-content:start;flex:1 1 auto;min-height:0}
.gs-list-footer{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;align-items:center;
  padding-top:4px;font-size:12px}
.gs-card{display:flex;flex-direction:column;gap:4px;text-align:start;appearance:none;cursor:pointer;
  border:1px solid var(--gs-border);border-radius:12px;padding:12px;
  background:var(--gs-surface);color:inherit;min-height:96px;position:relative;
  transition:transform .18s cubic-bezier(.16,1,.3,1),border-color .18s,box-shadow .18s}
.gs-card:hover:not([disabled]){border-color:var(--gs-accent);transform:translateY(-2px);
  box-shadow:0 12px 22px -14px rgba(0,0,0,.85), 0 2px 6px -2px rgba(255,122,26,.25)}
.gs-card[disabled]{opacity:.6;cursor:default}
.gs-card-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.gs-card-name{font-size:12px;color:var(--gs-muted);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.gs-card-go{margin-top:auto;font-size:12px;color:var(--gs-accent)}
@media (max-width:900px){
  .gs-body{flex-direction:column}
  .gs-chat{flex:0 0 auto;max-height:52%;border-inline-start:0;
    border-top:1px solid var(--gs-border)}
  .gs-side{flex:0 0 auto;max-height:52%;border-inline-start:0;
    border-top:1px solid var(--gs-border)}
}
`

    function apply(ctx) {
      const pickDirectory = async () => {
        const uiWorkspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
        if (uiWorkspace?.pickDirectory) return uiWorkspace.pickDirectory()
        const native = globalThis.__DSH_DIRECTORY_PICKER__
        if (native?.pick) return native.pick()
        throw new Error('这台 Desktop 没有可用的目录选择器。')
      }
      Panel.pickDirectory = pickDirectory
      // 供本机测试脚本单独渲染诊断边界用；不是 Desktop 协议字段。
      Panel.DiagnosticBoundary = DiagnosticBoundary
      Panel.FailureNotice = FailureNotice

      // 在宿主会话输入框（话筒附近）植入「画板」图标：点击通过 window 事件通知面板召出画板。
      // 这是宿主提供的合法注入点（list 槽位），不遮挡/替换宿主自带的话筒与公共入口。
      function ComposerPaintButton() {
        return h('button', {
          type: 'button',
          className: 'gs-composer-icon',
          title: '画板',
          'aria-label': '打开画板',
          onClick: () => {
            try {
              window.dispatchEvent(new window.CustomEvent('game-studio:toggle-paint'))
            } catch (cause) {
              console.error('[game-studio] toggle paint failed', cause)
            }
          }
        },
        // 自绘调色板图标：统一 1.6 描边，不用 emoji 当图标。
        h('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
        h('path', { d: 'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.3H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z' }),
        h('circle', { cx: 7.5, cy: 12, r: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 10, cy: 8, r: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 14.5, cy: 7.5, r: 1.2, fill: 'currentColor', stroke: 'none' })))
      }
      try {
        const slots = ctx.get?.('slots') ?? ctx.slots
        if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          slots.inject('conversation.input.right', () => slots.register({
            name: 'conversation.input.right',
            id: 'game-studio-paint',
            order: 0,
            inject: () => ({})
          }, ComposerPaintButton))
        }
      } catch (cause) {
        console.error('[game-studio] composer paint slot registration failed', cause)
      }

      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: '沙盒游戏工坊',
        panelTitle: '沙盒游戏工坊',
        repository: 'https://github.com/local-user/dsh-game-studio',
        description: '在工作区里加载静态网页小游戏，localhost 实时预览，边聊边改。',
        audience: '想自己做游戏的青少年',
        customFrame: true
      }, (props) => h(DiagnosticBoundary, null, h(Panel, props))))
    }

    return {
      apply,
      inject: ['desktopWorkbenches', 'slots'],
      // 本机测试脚本用的钩子；不是 Desktop 协议字段。
      diagnosticBoundary: DiagnosticBoundary,
      panelView: PanelView,
      panel: Panel,
      api
    }
  }
})
