# modify-remove-add Specification

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
The system SHALL store widgets in a dry place.

#### Scenario: Stored
- **WHEN** a widget is built
- **THEN** it is stored

#### Scenario: Kept dry
- **WHEN** a widget is stored
- **THEN** the place is dry

### Requirement: Track
The system SHALL track every widget.

#### Scenario: Tracked
- **WHEN** a widget moves
- **THEN** its place is recorded

