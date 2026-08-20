# CI Unit Testing

## Purpose

Defines where the unit test suite runs automatically and what it blocks when it fails:
the merge request pipeline in GitLab CI.

The requirements below fix the one gate a contributor meets — before the build job on a
merge request — and the pipelines that are deliberately left ungated.

## Requirements

### Requirement: MR pipelines run the unit test suite before the build job

The GitLab CI pipeline for merge requests SHALL run `npm run test` in a
dedicated `unit_tests` job, and the existing `buildonly_ansible` job SHALL
declare `unit_tests` as a `needs:` dependency so it does not run when the
test job fails. Both jobs SHALL skip merge requests whose title marks them as a
draft, so that the repeated pushes made during a change's implementation do not
occupy the runner. The draft and `[skip-ci]` exclusions MUST be declared once, as a
shared YAML anchor both jobs reference, rather than repeated per job.

#### Scenario: Unit tests pass on an MR

- **WHEN** a merge request pipeline runs and `npm run test` exits 0
- **THEN** `buildonly_ansible` proceeds to run

#### Scenario: Unit tests fail on an MR

- **WHEN** a merge request pipeline runs and `npm run test` exits non-zero
- **THEN** `unit_tests` fails and `buildonly_ansible` does not run

#### Scenario: The merge request is a draft

- **WHEN** a pipeline runs for a merge request whose title begins with a draft marker
- **THEN** neither `unit_tests` nor `buildonly_ansible` runs

#### Scenario: A draft merge request leaves draft

- **WHEN** a commit is pushed to a merge request whose title no longer begins with a draft
  marker
- **THEN** `unit_tests` runs, and `buildonly_ansible` follows on success

#### Scenario: Branch push pipelines are unaffected

- **WHEN** a pipeline runs from a direct push to `develop` or `main` (not an
  MR)
- **THEN** `unit_tests` does not run, and `deploy_develop_ansible` /
  `deploy_prod_ansible` are not gated by it
