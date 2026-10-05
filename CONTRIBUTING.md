# Contributing

This project accepts small fixes and improvements, but all contributions are
subject to the terms below.

## Permission to contribute

The additional permission in [`LICENSE`](LICENSE) allows you to fork, modify,
and publicly share code solely to prepare, submit, and review a contribution
to this repository. Keep the copyright notice and the complete license in
copies shared for that purpose. This exception does not permit independent
releases, independently maintained forks for other purposes, or products and
services based on Sealwire.

You must agree to the contribution terms below to use this exception. They
grant the maintainer rights to publish and relicense your contribution;
contributions are not offered to the maintainer solely under an internal-use
license.

## Contribution terms

By submitting any contribution to this repository, including code, tests,
documentation, or other material intended for inclusion in the project, you
represent that you have the right to submit that contribution and you agree
that:

- You retain ownership of your contribution.
- You grant Yikai Lan and their successors and assigns a perpetual, worldwide,
  non-exclusive, irrevocable, royalty-free license to use, reproduce, modify,
  distribute, sublicense, publicly display, publicly perform, and relicense
  your contribution, as part of this project or otherwise, under any license
  terms.
- To the extent you have the right to do so, you also grant a perpetual,
  worldwide, non-exclusive, irrevocable, royalty-free patent license covering
  patent claims necessarily infringed by your contribution as submitted.
- You understand that this project is distributed under the PolyForm Internal
  Use License 1.0.0 with the additional permissions in `LICENSE`, and that the
  maintainer may offer the project, including your contribution, under different
  license terms in the future.

If you do not agree to these terms, do not submit a pull request or patch.
Issues and design feedback are still welcome.

## Code Organization

- Default to keeping production code and tests in separate files once a module
  is non-trivial. Prefer sibling test modules such as `foo/tests.rs` or a
  crate-level `tests.rs` over growing inline `mod tests` blocks inside the main
  implementation file.
- Small leaf helpers can still keep a tiny inline test block when it is the
  clearest option, but larger files should move tests out before they become a
  second concern mixed into the main code path.
