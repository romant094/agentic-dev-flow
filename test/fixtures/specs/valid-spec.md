# widgets Specification

## Purpose

Widgets are the unit the system builds, stores and reports on for every user.

## Requirements

### Requirement: Widgets are stored
The system SHALL store every widget it builds.

#### Scenario: A built widget is stored
- **WHEN** a widget is built
- **THEN** it is stored

### Requirement: Widgets are reported
The system MUST report each stored widget once.

#### Scenario: A stored widget is reported
- **WHEN** a report runs
- **THEN** each stored widget appears once
