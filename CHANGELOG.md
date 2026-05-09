## [1.0.12](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.11...v1.0.12) (2026-05-09)


### Bug Fixes

* propagate idempotency keys to proton sync ([a4b2c51](https://github.com/hacker-h/proton-calendar-cli/commit/a4b2c5127f823d7cfcbda8a0322f98ead263ad38))

## [1.0.11](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.10...v1.0.11) (2026-05-09)


### Bug Fixes

* parse occurrence ids from final separator ([6c48e6b](https://github.com/hacker-h/proton-calendar-cli/commit/6c48e6b6573b15b56d38e98b43db5b4c8c1cb6ee))

## [1.0.10](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.9...v1.0.10) (2026-05-09)


### Bug Fixes

* cover blank cli validation edges ([0f6d604](https://github.com/hacker-h/proton-calendar-cli/commit/0f6d60490c45373c2c483a61abe40bfdcf5e6d53))
* reject whitespace-only cli values ([9a3f9bc](https://github.com/hacker-h/proton-calendar-cli/commit/9a3f9bca4ae49e89b18700fc782098b0db2c47e6))

## [1.0.9](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.8...v1.0.9) (2026-05-09)


### Bug Fixes

* fold long vevent lines ([fe0d92c](https://github.com/hacker-h/proton-calendar-cli/commit/fe0d92c2ace3b9dfd036a78cdc7c284ff45b42d9))

## [1.0.8](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.7...v1.0.8) (2026-05-09)


### Bug Fixes

* support monthly byday recurrence ([4fa2c99](https://github.com/hacker-h/proton-calendar-cli/commit/4fa2c99b33e44b910a6c0458cc34665ab8dc3e70))

## [1.0.7](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.6...v1.0.7) (2026-05-09)


### Bug Fixes

* cap recurrence candidate iteration ([8f3c841](https://github.com/hacker-h/proton-calendar-cli/commit/8f3c841d371148c4a3a2ca743b231f05e976c19f))

## [1.0.6](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.5...v1.0.6) (2026-05-09)


### Bug Fixes

* support monthly BYDAY recurrence ([773b7f2](https://github.com/hacker-h/proton-calendar-cli/commit/773b7f25fddd9c9e12275c852ba3da1cd2cad588)), closes [#42](https://github.com/hacker-h/proton-calendar-cli/issues/42)

## [1.0.5](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.4...v1.0.5) (2026-05-09)


### Bug Fixes

* validate CLI timezone inputs ([089ae4f](https://github.com/hacker-h/proton-calendar-cli/commit/089ae4fde3751ef5c0525808f97b411a6b2dccf7))

## [1.0.4](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.3...v1.0.4) (2026-05-09)


### Bug Fixes

* exclude exdates from count budget ([bb4a622](https://github.com/hacker-h/proton-calendar-cli/commit/bb4a62207cafe20cb342edc9581a12e1a5e5215e))
* redact login token from stdout ([104763d](https://github.com/hacker-h/proton-calendar-cli/commit/104763d4e2be2dc9041d47ea9620eedd0783bc69))

## [1.0.3](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.2...v1.0.3) (2026-05-09)


### Bug Fixes

* stop leaking Chrome Safe Storage env ([79832ae](https://github.com/hacker-h/proton-calendar-cli/commit/79832aea73d72b7c8ce198cc2d74110e4da77de7))

## [1.0.2](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.1...v1.0.2) (2026-05-09)


### Bug Fixes

* harden CI Proton login bootstrap ([8408af2](https://github.com/hacker-h/proton-calendar-cli/commit/8408af22b64ce3031ba8d5eaa2134566c2bf0bed))

## [1.0.1](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.0...v1.0.1) (2026-05-09)


### Bug Fixes

* guard locked git-crypt secret sync ([6794456](https://github.com/hacker-h/proton-calendar-cli/commit/6794456148611df13f470f12bab955cd503f7100)), closes [#32](https://github.com/hacker-h/proton-calendar-cli/issues/32)

# 1.0.0 (2026-05-09)


### Bug Fixes

* clarify login next shell step ([254b03c](https://github.com/hacker-h/proton-calendar-cli/commit/254b03c66334201703aac4018768fe11ea526d83))
* guard auth status ApiError handling ([2c02e28](https://github.com/hacker-h/proton-calendar-cli/commit/2c02e2808122c5d0018fb4b555a7fa1f1a7af481))
* pass app version into Playwright evaluate ([b228af3](https://github.com/hacker-h/proton-calendar-cli/commit/b228af328183218610dedf1b1904ff6e5bdffea4))
* prefer pc ls in CLI next steps ([ff56aee](https://github.com/hacker-h/proton-calendar-cli/commit/ff56aeeb74ea2a462ab81a838f64efe3ed98f76a))
* use timing-safe bearer token comparison ([ff6c49a](https://github.com/hacker-h/proton-calendar-cli/commit/ff6c49abd956555fbfcb89b7188ecb12b42b4a9e))

# Changelog

All notable changes to this project will be documented in this file.

This file is maintained by semantic-release.
