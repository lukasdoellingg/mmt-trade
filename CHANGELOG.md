# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Enterprise governance: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, ADRs
- Test pyramid: smoke, regression, integration, E2E (Playwright)
- CI/CD: fast PR pipeline, nightly regression, release workflow
- Pre-commit hooks (Husky + lint-staged)
- Scrum sprint documentation structure
- Dependabot configuration

### Changed

- Unified `npm test` entry point bundling all JS regression tests
- CI audit gate: fail on high/critical vulnerabilities

## [2.0.0] - 2026-05

### Added

- Monolithic Odin/Emscripten terminal engine (`packages/engine`)
- COOP/COEP WASM shell (`packages/shell`)
- MMT.gg parity workspace (Vue hybrid path)
- CBOR codec + MMT protocol skeleton
- Hardened Express backend with rate limiting and WS security gate

[Unreleased]: https://github.com/lukas/mmt-trade/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/lukas/mmt-trade/releases/tag/v2.0.0
