# trailing-section-crlf Specification

## Purpose
Reports are written by the system for every widget it ships to a customer.

## Requirements

### Requirement: Report
The system SHALL write a report.

#### Scenario: Reported
- **WHEN** a widget ships
- **THEN** a report is written

```text
## not a header inside a fence
```

### Requirement: Archive reports
The system SHALL archive reports.

#### Scenario: Archived
- **WHEN** a report is a year old
- **THEN** it is archived

## Notes

Free text after the requirements stays where it is.
