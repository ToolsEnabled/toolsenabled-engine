# Installed role memory compatibility

Shell organisation edits and the engine's installed authority reader use the
same `createInstalledAgentOrgStores` location decision. The default owner host
does not accept a caller-selected role file. The low-level factory's explicit
`roleMemoryFile` remains an intentional embedding/test contract.

- New state uses `custom-roles.json` in the owner-fenced service directory.
- If that file is absent and `durable-memory.json` contains any `custom-roles`
  namespace entry, both readers and writers use the legacy file in place.
- A present canonical file plus any legacy role-namespace entry refuses with
  `INSTALLED_ROLE_MEMORY_CONFLICT`. An empty canonical file may represent a
  deliberate reset. Equal visible definitions do not prove a common revision or
  deletion history, so those histories are not merged either.
- Unrelated legacy namespaces do not select the legacy file. They are never
  copied or removed. Unreadable or malformed candidates refuse rather than
  becoming an empty role vocabulary.

The installed factory exposes `roleMemorySelection` and `roleMemoryFiles` for
diagnosis. A new `read()` reselects and reloads; the owner-host memo stamps both
possible role files, including absence, so either file appearing, changing or
disappearing invalidates the cached authority on the next check. The returned
low-level role store is a snapshot; obtain a fresh factory/read before a later
operation rather than retaining an old store across external edits.

No owner data is migrated automatically. On conflict, preserve both originals
and explicitly reconcile the chosen authority while writers are stopped before
retrying. There is no merge or copy-migration API in this repair. In particular,
the existing file backend does not supply an interprocess lock or a cross-file
transaction, and this location decision does not add one. Physically erased
history cannot be recovered: the existing format removes entries, not a durable
tombstone log. Any retained unknown/tombstone-like entry in the role namespace
still counts as history for conflict detection; it is not treated as a valid
role definition.
