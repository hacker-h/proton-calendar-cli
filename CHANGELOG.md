## [1.4.5](https://github.com/hacker-h/proton-calendar-cli/compare/v1.4.4...v1.4.5) (2026-05-10)


### Bug Fixes

* accept publishable private false metadata ([eaa90a1](https://github.com/hacker-h/proton-calendar-cli/commit/eaa90a18b592948fb40b604d1168a771462259ce))
* skip npm pack lifecycle scripts in readiness ([ae0d978](https://github.com/hacker-h/proton-calendar-cli/commit/ae0d978c177fb996415efca5b75b8edddbe849b7))

## [1.4.4](https://github.com/hacker-h/proton-calendar-cli/compare/v1.4.3...v1.4.4) (2026-05-10)


### Bug Fixes

* resolve npm command on Windows ([6614a4f](https://github.com/hacker-h/proton-calendar-cli/commit/6614a4f2e2801ed7a258f4e39c87086fcbb4a7d2))
* skip executable bit check on Windows ([e2b06a7](https://github.com/hacker-h/proton-calendar-cli/commit/e2b06a706a1cfdad68f5c3bdfc78d9b508ea92f7))

## [1.4.3](https://github.com/hacker-h/proton-calendar-cli/compare/v1.4.2...v1.4.3) (2026-05-10)


### Bug Fixes

* evict Proton caches on session changes ([ec76090](https://github.com/hacker-h/proton-calendar-cli/commit/ec76090296bc4a922c2237700cba40712ebdee0d))
* track cookie session generations ([920e626](https://github.com/hacker-h/proton-calendar-cli/commit/920e626cb701961d514f193dff45d8e82bc839e0))

## [1.4.2](https://github.com/hacker-h/proton-calendar-cli/compare/v1.4.1...v1.4.2) (2026-05-10)


### Bug Fixes

* add stable CLI exit codes ([4e8fd83](https://github.com/hacker-h/proton-calendar-cli/commit/4e8fd83fb45eba15a9af2db8e9e3294090bed917))

## [1.4.1](https://github.com/hacker-h/proton-calendar-cli/compare/v1.4.0...v1.4.1) (2026-05-10)


### Bug Fixes

* generate live canary bearer tokens ([dfc7e2a](https://github.com/hacker-h/proton-calendar-cli/commit/dfc7e2acfb6cc6e129c048e7fdbbdd0e0fcbccdf))

# [1.4.0](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.5...v1.4.0) (2026-05-10)


### Features

* add deterministic agenda windows ([65cda21](https://github.com/hacker-h/proton-calendar-cli/commit/65cda217c7a8f1940cc414b2c8514429dbf8a5ed))

## [1.3.5](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.4...v1.3.5) (2026-05-10)


### Bug Fixes

* handle monthly recurrence short months ([9dd52c4](https://github.com/hacker-h/proton-calendar-cli/commit/9dd52c455face5dadbd455655a57248392acb776))

## [1.3.4](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.3...v1.3.4) (2026-05-10)


### Bug Fixes

* preserve zoned recurrence wall time ([c59380c](https://github.com/hacker-h/proton-calendar-cli/commit/c59380c9802ad3ef725253bf9c863ab2f32e2879))

## [1.3.3](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.2...v1.3.3) (2026-05-10)


### Bug Fixes

* fail closed on CLI listing caps ([3367f7f](https://github.com/hacker-h/proton-calendar-cli/commit/3367f7fb38432a7c046336e155066fadd8cebcbd))
* fail closed on Proton event page caps ([c4aaa5f](https://github.com/hacker-h/proton-calendar-cli/commit/c4aaa5fe51e88a60d3870b1adcdd0ee2f26af55b))
* fail closed on service listing caps ([0b34cef](https://github.com/hacker-h/proton-calendar-cli/commit/0b34cef9d497afdaefcec8a6e5fc81741b38e8e6))

## [1.3.2](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.1...v1.3.2) (2026-05-10)


### Bug Fixes

* complete Proton retry state handling ([f8206fb](https://github.com/hacker-h/proton-calendar-cli/commit/f8206fb7f52a1e9be5f44cdf2bc219dbdff22ce0))
* respect Proton retry-after ([64105e3](https://github.com/hacker-h/proton-calendar-cli/commit/64105e3b51be8308c5afccbf90d8f08e8d01970e))
* surface login rate limits ([f7311c7](https://github.com/hacker-h/proton-calendar-cli/commit/f7311c7e4d957ba3a2a9fd5ef5d648b82c0fd137))

## [1.3.1](https://github.com/hacker-h/proton-calendar-cli/compare/v1.3.0...v1.3.1) (2026-05-10)


### Bug Fixes

* include request ids in API errors ([64eb19e](https://github.com/hacker-h/proton-calendar-cli/commit/64eb19e30310e469dc16e6bb1ab0c8a1430aabda))
* pass API request ids through CLI ([78dd017](https://github.com/hacker-h/proton-calendar-cli/commit/78dd0172fe29c6e7883680f05bf994a6024818f2))
* sanitize upstream API error details ([e8e9949](https://github.com/hacker-h/proton-calendar-cli/commit/e8e99498b3ef5d38be1e5ff94594f27c10acde11))
* sanitize upstream CLI error details ([0fb83c2](https://github.com/hacker-h/proton-calendar-cli/commit/0fb83c263716fa0a614a2146cb5c1e245d5323c5))

# [1.3.0](https://github.com/hacker-h/proton-calendar-cli/compare/v1.2.2...v1.3.0) (2026-05-10)


### Features

* add calendar discovery api ([9f0dc67](https://github.com/hacker-h/proton-calendar-cli/commit/9f0dc679807620b9312eeb4fc725ed231280a871))
* add calendar discovery cli ([db3ccd1](https://github.com/hacker-h/proton-calendar-cli/commit/db3ccd164a413cd3b5f7b678390b4d2487781421))
* allow default calendar updates ([4346c4b](https://github.com/hacker-h/proton-calendar-cli/commit/4346c4b64e82cd16e3e5f00479d6928a1620a804))

## [1.2.2](https://github.com/hacker-h/proton-calendar-cli/compare/v1.2.1...v1.2.2) (2026-05-10)


### Bug Fixes

* harden relogin lock freshness ([a1b1764](https://github.com/hacker-h/proton-calendar-cli/commit/a1b1764b57889761dcbdcc98a11ab7a0f034d370))
* lock atomic cookie bundle writes ([186f609](https://github.com/hacker-h/proton-calendar-cli/commit/186f609e23d7602c667500fd5893fc5cab996a86))
* restore bootstrap profile setup ([23a9b47](https://github.com/hacker-h/proton-calendar-cli/commit/23a9b47d8439496a5bce5be9a509a706c2f07ba6))

## [1.2.1](https://github.com/hacker-h/proton-calendar-cli/compare/v1.2.0...v1.2.1) (2026-05-09)


### Bug Fixes

* harden cli validation contract ([e2470a8](https://github.com/hacker-h/proton-calendar-cli/commit/e2470a82284f4cfe3847bcf5fd6c96add6fc9217))

# [1.2.0](https://github.com/hacker-h/proton-calendar-cli/compare/v1.1.0...v1.2.0) (2026-05-09)


### Features

* harden doctor auth automation output ([f6c9b5e](https://github.com/hacker-h/proton-calendar-cli/commit/f6c9b5e7dc2f2fe84a005d6cdbc2022f79f67fa6))

# [1.1.0](https://github.com/hacker-h/proton-calendar-cli/compare/v1.0.12...v1.1.0) (2026-05-09)


### Bug Fixes

* reject unsafe cookie bundle permissions ([c550dd1](https://github.com/hacker-h/proton-calendar-cli/commit/c550dd16466e6d30724f3e57f539a3added79c3d))


### Features

* add logout secret cleanup ([9967d5e](https://github.com/hacker-h/proton-calendar-cli/commit/9967d5ec0ea98e8ab21b062a6c756e97250c791b))

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
