# Geode Headless pilot artifact

`rbcodelabs-geode-headless-0.1.0.tgz` is the compiled, public-npm-ready package from
[rbcodelabs/geode](https://github.com/rbcodelabs/geode), commit
`7fc2c7bc15e015c07a4ad27352833691f43ddc1f` ([SDK PR](https://github.com/rbcodelabs/geode/pull/268)).
It is vendored so this preview pilot does not require publishing to npm.

SHA-512 integrity:
`sha512-gaBHsRTB3NCScAtzHoD0TuLg/gTL+iGJlFyGdtchNpFFvKuT0YSOloco72GvgR9xzD0jZQUnqYzwMt8/ufodZQ==`

From that Geode checkout, install its locked dependencies, run
`npm run build:headless`, then `npm pack ./packages/headless`.
The package contains its MIT license and documentation. The independent Node 22
consumer proof is `npm run proof:headless-package`.

The pnpm lockfile verifies the artifact. A future switch to a published npm version
requires a separate release decision and matching API/artifact verification.
