# Changelog

All notable changes to this repository are documented here. The project follows
the dsh-tui repository convention: user-facing behavior and public API changes
are logged in Chinese, with English summaries when appropriate.

## Unreleased

### Fixed

- **`/resume` 与 `/tree` 丢失历史与分叉会话**：上游 0.1.5 线把会话产物改成带世代的
  `session.vN.jsonl.zstd`,而 adapter 的定位器只探测 `session.jsonl.zstd`——真实 store 上
  122 个会话命中 0 个,离线日志层(会话树、离线改名/删除、标题恢复、种子读取)全线失效;
  同时 `locate()` 只报当前世代,旧世代会话拿到不存在的路径,标题/字节数/时间排序全部降级。
  定位器改为按世代解析(取可读的最高世代,兼容旧的无世代名),并在后端 `locate()`
  指向缺失世代时于同目录内纠正世代名。
- **分叉会话被判为游离而从家族树消失**:物理头退休了 `seedLength`,`sessionTree` 把
  「有 parentSession 但无精确切点」当作游离处理。改为从日志自身带 `inherited: true` 的
  `session/end-seed` 边界推导切点(切点即该事件的 seq),绝不由 `isSeeded`、日志长度或
  裸 `session/end-seed` 推断——真实 store 上有 12 个无父会话同样带这个事件。
  读取器顺带修正了继承前缀跳过:切点之后的事件是本会话自己的,只是共用父会话的 seq
  空间,此前会让长父会话的分叉几乎看不到自己的内容。
- **`decodeStorageRecord` 在 0.1.5 线被移除**:该符号经 `createRequire` 懒取,类型门禁
  看不见,直接调用会在每条日志的第一行抛错并把每个会话降级为「不可读」。改为运行时
  探测:上游仍导出就用上游的,否则本地按一行一事件解码;遇到没有展开器的打包行时
  让读取失败而不是静默丢弃整段助手输出。

### Changed

- 校验上游线移到 `0.1.5-alpha.1`(`0.1.2-rc.1` 降为兼容线),peer/dev 范围同步追加;
  `verify-web-coexistence` 的基线常量改为从 `contract.ts` 派生,避免第二处硬编码。

## Unreleased — adapter-v2 P4/P5/P6 (local dev-adapter-v2 branch)

### Added

- **P4 Channel Host Ports and Kernel slice**
  - Added internal `HostChannelPort` with five split surfaces:
    `projection`, `actions`, `state`, `plugins`, `transcript`.
  - Added `src/adapter/channel/*` split modules:
    `projection.ts`, `actions.ts`, `state.ts`, `plugins.ts`,
    `transcript.ts`, `host-registry.ts`.
  - Added `dsh-tui-channel` upstream driver and `channel` KernelSlice.
  - `KernelRuntime.facade()` now exposes the channel Port and applies
    per-method shadow policy through `HostFacade`.
  - Production TUI wiring registers the live Channel with the adapter kernel.
  - Honest note: this is a new Port/projection and split-module layer, not a
    physical split of the production `src/dsh-adapter/channel.ts`; the large
    live Channel implementation file remains the source of truth, and
    production UI actions still call the native Channel directly instead of
    going through `HostFacade.channel`.
  - New gate: `npm run verify:adapter-channel`.

- **P5 DSH event projection + Channel Provider/Consumer**
  - Added `ChannelProvider` and `ChannelConsumer` for the
    `tui.dsh/v1alpha1#Channel` operation envelope
    (`open` / `subscribe` / `invoke` / `close`).
  - Extended `src/adapter/kernel/replay.ts` with `runChannelReplay()` and a
    channel section on `runReplayShadow()`.
  - Replays use recorded snapshots or a minimal real DSH
    `agent.session.events` transcript projection (explicitly not a complete
    RFC 0007 Channel state projection); validate against the vendored
    dsh-ecosystem-spec validators and official fixture, and check monotonic
    versions, features and method→feature mappings.
  - Unknown methods fail per protocol; features must be explicitly declared
    and each must have observable evidence; duplicate features are rejected;
    unknown non-ignorable DSH events fail closed; method handlers only run
    inside replay isolation; replay provider explicitly does not resolve
    open selectors; continuity violations fail closed; replay JSON is
    size/depth bounded and deep-frozen.
  - Production channel-driver live protocol validation now runs
    open/subscribe/invoke/close through the real Provider/Consumer path.
  - New gate: `npm run verify:adapter-channel-conformance`.

### Removed / changed

- **P6 adapter compat cleanup**
  - Removed `src/plugin-spec/*` legacy shims.
  - Removed `src/dsh-adapter/grants.ts` and `src/dsh-adapter/host-descriptor.ts`
    legacy re-export shims.
  - Removed the internal `admissionCompat` /
    `admissionCompatCoordinates` option and `mountedAdmissionCoordinates()`
    helper.
  - All production imports now go to the canonical `src/adapter/standard/*`
    surface.
  - `src/plugin-host.ts` remains as the canonical public plugin-host surface
    without COMPAT markers.
  - `verify:compat-removal` now scans `src/`, `scripts/`, `bin/`, generated
    `lib/` (when present) and the package export graph (shim absence, no
    legacy imports/path refs, no admissionCompat references, canonical
    `./plugin-host` export) rather than marker self-certification.
  - `verify:package` rejects legacy shim paths in the npm tarball file list.
  - Retained compatibility aliases (`ExtensionGrants`, `envelopeSchema`,
    `createAdmissionCatalog`, `facadeFromLegacy`, etc.) are explicitly marked
    as P6-out-of-scope / long-term compatibility surface.

### Verification

- `pnpm exec tsc -p tsconfig.json --noEmit`
- `npm run verify:build` (includes all adapter gates above)
