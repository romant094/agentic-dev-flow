## RENAMED Requirements

- FROM: `### Requirement: Build`
- TO: `### Requirement: Assemble`

**Code Disposition**: Renamed in place.

## MODIFIED Requirements

### Requirement: Assemble
The system SHALL assemble widgets from parts.

#### Scenario: Assembled
- **WHEN** a widget is asked for
- **THEN** it is assembled from parts

### Requirement: Count
The system SHALL count widgets per day.

#### Scenario: Counted
- **WHEN** a widget is painted
- **THEN** the day's count goes up
