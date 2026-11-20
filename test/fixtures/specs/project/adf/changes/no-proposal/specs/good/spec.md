## ADDED Requirements

### Requirement: Widgets are archived
The system SHALL archive a widget older than a year.

#### Scenario: An old widget is archived
- **WHEN** a widget turns one year old
- **THEN** it is archived

## MODIFIED Requirements

### Requirement: Widgets are reported
The system MUST report each stored widget once a day.

#### Scenario: A stored widget is reported daily
- **WHEN** the daily report runs
- **THEN** each stored widget appears once

## REMOVED Requirements

### Requirement: Widgets are printed

## RENAMED Requirements

- FROM: `### Requirement: Widgets are stored`
- TO: `### Requirement: Widgets are persisted`
