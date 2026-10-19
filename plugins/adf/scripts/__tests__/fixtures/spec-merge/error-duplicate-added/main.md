# error-duplicate-added Specification

## Purpose
Widgets are built, stored and shipped by the system, in that order of steps.

## Requirements
The requirements below apply to every widget.

### Requirement: Build
The system SHALL build widgets.

#### Scenario: Built
- **WHEN** a widget is asked for
- **THEN** it is built

### Requirement: Store
The system SHALL store widgets.

#### Scenario: Stored
- **WHEN** a widget is built
- **THEN** it is stored

### Requirement: Ship
The system SHALL ship widgets.

#### Scenario: Shipped
- **WHEN** a widget is stored
- **THEN** it is shipped
