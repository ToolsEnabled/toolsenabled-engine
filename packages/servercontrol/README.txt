SERVER CONTROL PANEL v6
=======================

PURPOSE
  One local Windows control panel for the curated development servers and the
  three remote-access tiers. The same signed-off code bundle is deployed to
  Machine A and Machine B. Runtime choices stay local to each computer.

OPENING THE PANEL
  Double-click "Launch Control Panel.vbs". It starts the panel without
  allocating a cmd.exe/PowerShell console. "Launch Control Panel.cmd" remains
  as a compatibility forwarder to that quiet entry point. The login entry and
  ServerPanelWatchdog normally keep one hidden-to-tray instance alive.

  Left-click the tray icon to show the window. Right-click for per-server
  Start, Stop, and Open commands. The tray icon is green when every registered
  server is running, amber when some are running, and red when none are.

SERVER CONTROLS
  Every row has Start, Stop, Open, and three explicit preferences:

    Enabled           Desired runtime state. Turning it off intentionally stops
                      the service and prevents automatic recovery.
    Keep alive        While Enabled, recover the service if its listener exits.
    Start at sign-in  While Enabled, restore the service after Windows sign-in.

  Preferences are stored in the host-local servers.json. Closing the window
  hides the panel to the tray and stops non-persistent rows. Keep-alive rows
  continue in the background. That close policy does not silently clear
  Enabled, so an independent Start-at-sign-in choice remains effective.
  Missing application folders are shown as UNAVAILABLE and cannot be started;
  they never disappear silently.

CURATED SERVERS
  Agent Activity Visualizer  http://127.0.0.1:3889/
  Presentation Editor        http://127.0.0.1:4599/
  Scribe                     http://127.0.0.1:4610/
  Topology Games             http://127.0.0.1:4702/
  LEAN-Bench Quest           http://127.0.0.1:8123/
  Portfolio Dashboard        http://127.0.0.1:8420/
  Organizer Review           http://127.0.0.1:8765/

  ServerControl.Common.ps1 resolves the known A/B locations using local fixed
  drives only. ServerRegistry.ps1 remains byte-identical on both computers.
  Auto-discovery is intentionally disabled: incidental agent/test listeners do
  not become permanent UI rows.

REMOTE ACCESS - THREE INDEPENDENT TIERS
  Tier 1 / Tunnel
    Direct-Ethernet message relay on port 8787. Coordination messages only.

  Tier 2 / ToolsEnabled
    Authenticated, audited approved-tool transport on port 8788. It is not a
    shell, desktop, clipboard, or raw credential channel.

  Tier 3 / Full remote
    Independently controlled encrypted exact-peer agentic-control service.
    Its reviewed manifest, audit, credential, policy, and kill-switch
    boundaries remain active; it is not raw-secret or arbitrary-admin access.

  ToolsEnabled is the Tier-2 capability and enables/requires Tunnel for peer
  coordination. One serialized scheduled reconcile observes all three desired
  states, but each lane retains its own listener, health evidence, controller,
  error, and credential boundary. Full remote has its own control and audit
  boundary. Raw bootstrap ports 8791/8792 are closed during normal reconcile;
  enrollment is one-shot only. Secrets stay in the managed DPAPI vault and are
  never rendered, copied into the relay, persisted by this panel, or placed on
  a process command line.

PARITY AND DEPLOYMENT
  Source of truth: packages/servercontrol in the canonical Machine-B
  ToolsEnabled repository.

  Test-ServerControl.ps1 performs parser, dependency, UI-contract, lifecycle,
  and manifest checks without starting/stopping shared services.

  Deploy-ServerControl.ps1 stages and verifies only the allowlisted code bundle,
  preserves runtime state, creates a recoverable backup, then atomically
  promotes each file. Restarting the live panel is a separate, explicit action
  after the shared-service relay announcement.

  Generate-ServerControlManifest.ps1 writes the deterministic SHA-256 manifest
  used to prove A and B received the same code bytes.

  Validate first (read-only). <home> below is an example: substitute the
  operator's own Windows user profile folder (e.g. C:\Users\<you>) on each
  machine.

    Machine B
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File
        <home>\OneDrive\Desktop\ToolsEnabled\packages\servercontrol\Deploy-ServerControl.ps1
        -TargetRoot C:\agent-apps\ServerControl

    Machine A, after the reviewed private-repository update
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File
        <home>\Desktop\ToolsEnabled\packages\servercontrol\Deploy-ServerControl.ps1
        -TargetRoot <home>\Desktop\ServerControl

  Add -Promote to the same command only after validation and the required relay
  announcement. Promotion verifies every source byte, preserves servers.json
  and tunnel-state.json, creates a local rollback backup, and never restarts
  the live panel. Run Test-ServerControl.ps1 from each target afterward; both
  targets must report the same bundleVersion and manifest SHA-256.

VISUAL QA
  Server-Control-Panel.ps1 -RenderPreviewPath <local.png>

  This renders the real WinForms control tree offscreen and exits. It does not
  create a tray icon, write the heartbeat, change runtime preferences, start a
  server, or register a scheduled task.

BACKGROUND HELPERS
  ServerPanelWatchdog                 panel responsiveness and hidden relaunch
  ServerControl - Persistent Watchdog keep-alive reconciliation
  ServerControl - Start on restart    sign-in reconciliation
  ServerAggregator                    curated-registry normalization
  OrphanReaper                        bounded orphan cleanup

  All process launches are hidden/non-interactive. Do not bulk-kill PowerShell,
  Python, or Node processes; ownership is always verified first.
