# Architecture and module ownership

This document defines the responsibility boundaries used when splitting large files. New behavior should live in the narrowest module that owns it; page and application entry files should compose modules rather than implement storage or domain rules.

## Rust application

- `src-tauri/src/lib.rs`: Tauri application composition, plugin setup, managed state, and command registration only.
- `src-tauri/src/database.rs`: SQLite pool lifecycle, connection configuration, migration execution, legacy schema baselining, and database paths.
- `src-tauri/src/storage.rs`: data-directory migration and filesystem operations for attachments, exports, and fonts.
- `src-tauri/src/secret_store.rs`: AES-GCM API-key envelope encryption, OS keyring integration, and the process-memory decrypted-key cache.
- `src-tauri/src/agent_repository.rs`: Agent task, patch, transaction, and audit persistence.
- `src-tauri/src/agent_tools.rs`: native Agent tool commands and their database-backed execution.

Tauri commands should delegate immediately to these modules. Database code must use the shared pools from `database.rs`; opening ad hoc SQLite connections bypasses connection settings and migrations.

## Frontend application

- `src/pages`: route-level orchestration and visible workspace state. Pages may coordinate services but should not own parsing, persistence, or rendering algorithms.
- `src/composables`: Vue lifecycle and reactive workflows shared by a page or feature, such as AI secret loading and chat-history persistence.
- `src/services`: framework-independent application workflows and integrations.
- `src/repositories`: persistence contracts; `src/infrastructure` contains their Tauri/SQLite implementations.
- `src/models`: shared domain types, defaults, validation, and serialization boundaries.
- `src/editor`: TipTap integration and editor-specific pure modules. `EditorShell.vue` owns editor UI composition; parsing, outline construction, block operations, and storage helpers belong in adjacent modules.

## Dependency direction

UI components depend on composables and services. Services depend on repository interfaces and models. Infrastructure implements repository interfaces and is selected at the application boundary. Domain models and pure editor utilities must not import Vue components or Tauri APIs.

Startup paths must remain non-blocking: database initialization and the initial document list may run at startup, but API-key/keyring access is lazy and begins only when an AI action requires it.

## Feature ownership

- `useDocumentCollection`: owns the active/deleted document collections, sidebar tree projection, group selection, and expansion state. Pages consume this API instead of synchronizing multiple lists or rebuilding tree state.
- `DocumentSidebar.vue`: owns the document-navigation surface, tree projection, group counts, file input, and semantic UI events. It does not call document services or mutate application state directly.
- `useDocumentSearch`: owns query indexing, result projection, search-modal lifecycle, and result snippets. Navigation after choosing a result remains a page-level concern.
- `useSensitiveAuthorization`: owns the complete password authorization state machine. Callers request authorization and receive a boolean; they do not manipulate pending promise resolvers.
- `models/theme.ts`: owns theme identifiers and persisted-value normalization. `services/theme.ts` owns DOM application, system-theme observation, and CSS variables.
- `editor/documentTemplate.ts`: owns valid initial TipTap documents. File-name and import-extension rules live in `pages/documentFile.ts` because they belong to the document workspace boundary rather than the editor engine.
- `models/documentLink.ts`: owns the backward-compatible internal document/block link format. UI surfaces parse links through this module rather than slicing hashes themselves.
- `models/documentBlock.ts`: defines the read-only block projection contract. `documents.content_json` remains the write source of truth; SQLite triggers own projection synchronization.
- `services/AgentCommandService.ts`: validates deterministic write commands and expands them into confirmation proposals. It never writes documents or imports Tauri APIs.

## Remaining decomposition targets

The following files are still composition hotspots. Refactors should extract complete responsibilities with narrow inputs and outputs, not merely move line ranges:

1. `pages/HomePage.vue`: extract the AI/Agent session coordinator, document import/export workflow, and document command controller. Keep the page responsible for wiring workspace surfaces together.
2. `editor/EditorShell.vue`: extract toolbar/context-menu surfaces and editor interaction composables. Keep TipTap creation and public editor commands in the shell.
3. `editor/blockControls.ts`: separate ProseMirror selection/positioning mechanics from block commands and clipboard behavior.
4. `pages/SettingsPage.vue`: split settings sections into focused form components while the page owns draft state and emits one normalized settings contract.
5. `infrastructure/database/TauriDocumentRepository.ts`: separate row mapping/query definitions from repository transaction orchestration.

Cross-layer imports should be checked during each extraction. In particular, `models` must not depend on `services`, and infrastructure-specific Tauri APIs must not leak into models, repositories, or reusable editor algorithms.
