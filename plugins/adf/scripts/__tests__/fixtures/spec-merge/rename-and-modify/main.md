# rename-and-modify Specification

## Purpose
Widgets are built and then painted by the system, one widget at a time.

## Requirements
### Requirement: Build
The system SHALL build widgets.

#### Scenario: Built
- **WHEN** a widget is asked for
- **THEN** it is built

### Requirement: Paint
The system SHALL paint widgets.

#### Scenario: Painted
- **WHEN** a widget is built
- **THEN** it is painted

### Requirement: Count
The system SHALL count widgets.

#### Scenario: Counted
- **WHEN** a widget is painted
- **THEN** the count goes up
