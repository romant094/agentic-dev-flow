# rename-and-modify Specification

## Purpose
Widgets are built and then painted by the system, one widget at a time.
## Requirements
### Requirement: Paint
The system SHALL paint widgets.

#### Scenario: Painted
- **WHEN** a widget is built
- **THEN** it is painted

### Requirement: Count
The system SHALL count widgets per day.

#### Scenario: Counted
- **WHEN** a widget is painted
- **THEN** the day's count goes up

### Requirement: Assemble
The system SHALL assemble widgets from parts.

#### Scenario: Assembled
- **WHEN** a widget is asked for
- **THEN** it is assembled from parts

