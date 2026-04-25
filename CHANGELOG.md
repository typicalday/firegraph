# Changelog

## [0.11.2](https://github.com/typicalday/firegraph/compare/v0.11.1...v0.11.2) (2026-04-25)


### Bug Fixes

* **cloudflare:** make FiregraphDO extend DurableObject + Miniflare RPC test ([39c4b95](https://github.com/typicalday/firegraph/commit/39c4b95d12d8c61fc8a09719879aafaeded42ac2))
* **cloudflare:** make FiregraphDO extend DurableObject for RPC compatibility ([ddda819](https://github.com/typicalday/firegraph/commit/ddda8198457045b45c21bf0f7178d7c8ce2b49e5))
* **json-schema:** preserve all errors, fix path rendering, memoize bootstrap ([a68674e](https://github.com/typicalday/firegraph/commit/a68674e1ad0536202c128b3343358504f971bd13))
* swap Ajv for @cfworker/json-schema for Workers compatibility ([a6ddfe3](https://github.com/typicalday/firegraph/commit/a6ddfe35fcfde6c61f164f5deb23499f76147053))
* swap Ajv for @cfworker/json-schema so dynamic registries run on Workers ([4804e0e](https://github.com/typicalday/firegraph/commit/4804e0e7de509484b82a5f704210fd9be0b192be))


### Performance Improvements

* **typecheck:** scope workers-types import to do.ts via triple-slash ([1616c68](https://github.com/typicalday/firegraph/commit/1616c68a70c34cb4da1f021d2482d8e939103fe3))

## [0.11.1](https://github.com/typicalday/firegraph/compare/v0.11.0...v0.11.1) (2026-04-24)


### Bug Fixes

* **ci:** upgrade npm for Trusted Publishing + add manual dispatch ([947751e](https://github.com/typicalday/firegraph/commit/947751e38678d777174b32224c0b800262413e13))
* **ci:** upgrade npm for Trusted Publishing + add manual dispatch ([e1c3e0c](https://github.com/typicalday/firegraph/commit/e1c3e0c4597d03714ef07427f492ec8ae9137c3e))
* **ci:** use Node 24 so npm publish has OIDC support ([2b92d1b](https://github.com/typicalday/firegraph/commit/2b92d1b4e27b98e565c151f454c0b206b3b82226))
* **ci:** use Node 24 so npm publish has OIDC support ([37db47c](https://github.com/typicalday/firegraph/commit/37db47c4a2206e41ebd422ebbe4910139e0a4698))

## [0.11.0](https://github.com/typicalday/firegraph/compare/v0.10.0...v0.11.0) (2026-04-23)


### Features

* **ci:** use npm Trusted Publishing (OIDC) instead of NPM_TOKEN ([7cfa838](https://github.com/typicalday/firegraph/commit/7cfa83802691d6f55665f772f777a8bc06c29ace))
* **indexes:** unified IndexSpec preset + per-triple indexes across backends ([a13e115](https://github.com/typicalday/firegraph/commit/a13e1159b85f08c3c35ecf85e3f558bfa21573fe))
* **indexes:** unified IndexSpec preset + per-triple indexes across backends ([78aede8](https://github.com/typicalday/firegraph/commit/78aede84fba22b69696988809a8b9ff2d657e0c4))


### Bug Fixes

* **ci:** install editor deps before running unit tests ([e71ff3c](https://github.com/typicalday/firegraph/commit/e71ff3ceeb8cea37d6ab13db8d81c4f34c1c74c6))
* **ci:** whitelist native build scripts + bump integration Java to 21 ([d110952](https://github.com/typicalday/firegraph/commit/d110952f30afafc5a5f10000bf137cc380ef8acc))


### Reverts

* **ci:** use NPM_TOKEN instead of Trusted Publishing ([7ffe107](https://github.com/typicalday/firegraph/commit/7ffe107fc411b22bf870e916586c31f74b09715a))

## Changelog
