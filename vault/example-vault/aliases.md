# Aliases

Single global entity-resolution map. Each line maps one or more surface forms to one canonical
vault entity, in the format `surface form · email · phone → [[Canonical Entity]]`, so a spoken name,
an email address, and a board client all resolve to the same page. `ingest` consults this map first,
then falls back to heuristic matching; new aliases discovered during ingest are appended here.

<!-- Example: Jane · Jane Doe · jane.doe@example.com · +1 555 123 4567 → [[Jane Doe]] -->
