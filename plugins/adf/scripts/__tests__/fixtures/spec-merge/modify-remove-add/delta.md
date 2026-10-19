## ADDED Requirements

### Requirement: Track
The system SHALL track every widget.

#### Scenario: Tracked
- **WHEN** a widget moves
- **THEN** its place is recorded

## MODIFIED Requirements

### Requirement: Store
The system SHALL store widgets in a dry place.

#### Scenario: Stored
- **WHEN** a widget is built
- **THEN** it is stored

#### Scenario: Kept dry
- **WHEN** a widget is stored
- **THEN** the place is dry

## REMOVED Requirements

### Requirement: Ship
**Reason**: Shipping moved to another system.
**Migration**: Use the shipping system.
**Code Disposition**: Deleted.
