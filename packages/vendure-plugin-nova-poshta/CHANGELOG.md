# @uplab/vendure-plugin-nova-poshta

## 0.1.3

### Patch Changes

- [#43](https://github.com/Uplab/uplab-vendure-plugins/pull/43) [`c7d7775`](https://github.com/Uplab/uplab-vendure-plugins/commit/c7d777541307cf7be3a80b07f9e3438e9c03c2f1) Thanks [@brmk](https://github.com/brmk)! - Install alongside Vendure 3.8: the `@nestjs/common` and `@nestjs/core` peers now accept `^11 || ^12`, and `@nestjs/graphql` accepts `^13 || ^14`. Vendure 3.8 moved to NestJS 12, so `npm install` failed with `ERESOLVE` against the old `^11` / `^13` ranges. Nothing changes on Vendure 3.7.

## 0.1.2

### Patch Changes

- [#41](https://github.com/Uplab/uplab-vendure-plugins/pull/41) [`31d5deb`](https://github.com/Uplab/uplab-vendure-plugins/commit/31d5deba10edce2aef108da53358fafbb5ff7fae) Thanks [@brmk](https://github.com/brmk)! - Ship the LICENSE file in the package.

## 0.1.1

### Patch Changes

- [#26](https://github.com/Uplab/uplab-vendure-plugins/pull/26) [`0e7568c`](https://github.com/Uplab/uplab-vendure-plugins/commit/0e7568c47b3ec126245c88794111d401fabed058) Thanks [@brmk](https://github.com/brmk)! - The warehouse types on the country page are a multi-select of the four Nova Poshta types, not a free-text tag input that ignores them.

## 0.1.0

### Minor Changes

- [#23](https://github.com/Uplab/uplab-vendure-plugins/pull/23) [`8972564`](https://github.com/Uplab/uplab-vendure-plugins/commit/8972564d8b665edcd63057ba60eac9b02b740f90) Thanks [@brmk](https://github.com/brmk)! - Initial release: Nova Poshta city and warehouse lookups in the Shop API, for Ukraine and abroad, with the warehouse types offered per country and a daily sync of Nova Poshta's country refs.
