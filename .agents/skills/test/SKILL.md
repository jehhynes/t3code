---
name: test
description: Run chosen T3 Code test files or one package's test suite.
---

# Run tests

- Run chosen test files with `vp test run <file>...` from the repository root, optionally with `-t "<name>"` for one case of a large file.
- Run one package's whole suite with `vp run --filter <package> test`, such as `vp run --filter @t3tools/web test`.
