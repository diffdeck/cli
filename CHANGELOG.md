# Changelog

## [1.5.2](https://github.com/diffdeck/cli/compare/v1.5.1...v1.5.2) (2026-07-14)


### Bug Fixes

* fetch baseline commit on demand so incremental rendering works on shallow clones ([#13](https://github.com/diffdeck/cli/issues/13)) ([e39932c](https://github.com/diffdeck/cli/commit/e39932c6d6154670c86bea198738adb04b01f92d))

## [1.5.1](https://github.com/diffdeck/cli/compare/v1.5.0...v1.5.1) (2026-07-11)


### Bug Fixes

* unbreak npm trusted-publishing step in the release workflow ([#11](https://github.com/diffdeck/cli/issues/11)) ([1184d20](https://github.com/diffdeck/cli/commit/1184d20e7069e594a6aed20dd0823ffa4487b190))

## [1.5.0](https://github.com/diffdeck/cli/compare/v1.4.0...v1.5.0) (2026-07-11)


### Features

* forward the pull request number to the builds API ([#9](https://github.com/diffdeck/cli/issues/9)) ([a1c509a](https://github.com/diffdeck/cli/commit/a1c509aebc5668b01bd82a1bbef57c32ca55d8af))

## [1.4.0](https://github.com/diffdeck/cli/compare/v1.3.0...v1.4.0) (2026-07-02)


### Features

* send the repository default branch with Storybook uploads ([#7](https://github.com/diffdeck/cli/issues/7)) ([5cdf54a](https://github.com/diffdeck/cli/commit/5cdf54af6605c55ae58cb5a47718542a0bcbd44c))

## [1.3.0](https://github.com/diffdeck/cli/compare/v1.2.0...v1.3.0) (2026-07-02)


### Features

* incremental (TurboSnap) rendering for screenshot-storybook ([48e7710](https://github.com/diffdeck/cli/commit/48e7710a87838188d1610f73684b21b898f43e8f))

## [1.2.0](https://github.com/diffdeck/cli/compare/v1.1.1...v1.2.0) (2026-07-02)


### Features

* in-page story switching + fix sb-errordisplay false positive ([5785536](https://github.com/diffdeck/cli/commit/5785536331b1b076226c737ff67558060caefbe5))

## [1.1.1](https://github.com/diffdeck/cli/compare/v1.1.0...v1.1.1) (2026-07-02)


### Bug Fixes

* pin locale/timezone; faster settle + higher default concurrency ([57cbd54](https://github.com/diffdeck/cli/commit/57cbd540a62d5d9cb87043cf022f24ccde1059dd))

## [1.1.0](https://github.com/diffdeck/cli/compare/v1.0.0...v1.1.0) (2026-07-02)


### Features

* parallelize screenshot rendering with live progress ([8d5e08f](https://github.com/diffdeck/cli/commit/8d5e08f14f28b8aadb180b071fe65a5efeb5e58c))

## 1.0.0 (2026-07-02)


### Features

* add screenshot-storybook command (CI-side render + render-check) ([64e1f26](https://github.com/diffdeck/cli/commit/64e1f26ab535237231bfdaaccaeada4e3b6f53a0))
