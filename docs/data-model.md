# Data model

Single-table design in the `Content` table (`infra/cdk/lib/data-stack.ts`), plus a separate
`Users` table.

## Content table

| Item         | PK                     | SK                                    | Notes                                  |
| ------------ | ---------------------- | ------------------------------------- | -------------------------------------- |
| Thing        | `THING#<id>`           | `META`                                | The dangerous thing itself             |
| ThingType    | `THINGTYPE#<id>`       | `META`                                | Taxonomy: plant, food, medication, ... |
| PetType      | `PETTYPE#<id>`         | `META`                                | Taxonomy: dog, cat, horse              |
| Contribution | `THING#<id or new-id>` | `CONTRIB#<createdAt>#<contributorId>` | Pending edit/addition                  |

`Thing.details` and `ThingType.details`/`PetType.details` are free-form maps — this is
where "unstructured data" lives (toxic principles, dose thresholds, clinical signs,
whatever a contributor adds) without needing a schema migration.

**GSI1** (`GSI1PK=THINGTYPE#<type>`, `GSI1SK=THING#<name>`): browse Things by thing type.
Thing type is single-valued per Thing, so this is a clean GSI use.

**GSI2** (`GSI2PK=STATUS#pending`, `GSI2SK=CONTRIB#<createdAt>`): the moderation queue.

**No GSI for pet type.** A Thing can be dangerous to multiple pet types (`petTypes: []`),
and DynamoDB GSIs only take one value per item per index — you'd need a denormalized
pointer item per pet type to query that way. At ~1,000 rows it's simpler and just as fast
to filter the in-memory search cache (`SearchService.filterByPetType`) than to maintain
that denormalization. Revisit if the dataset grows past what comfortably fits in Lambda
memory.

## Users table

`PK=USER#<provider>#<providerAccountId>`. Keyed by provider account, not by our own
internal `id` — that's what guards use day to day (`VerifiedGuard` re-checks
`verifiedContributor` against the live record on every request rather than trusting the
JWT's claim, which goes stale the moment the quiz is passed or a professional verification
approved — see `docs/verification-flow.md`).

**GSI1** (`GSI1PK=USERID#<id>`, no sort key): lookup by internal `id`. Added specifically
for reviewing professional verifications (`POST /verification/professional/:userId/review`
only has the internal id to go on) and for stamping `verifiedOrgDomain` onto approved
contributions (`ContributionsService.approve` looks up the contributor by id).

Professional verification adds a few internal-only fields not part of the public `User`
shape — `professionalEmail`, `professionalCodeHash`, `professionalCodeExpiresAt` — stripped
before any read reaches the API (`stripInternalUserFields` in `users.service.ts`, the Users
table's equivalent of `stripDynamoKeys`).

## Search

`SearchService` scans the whole `Content` table (filtered to Things), caches it 60s, and
searches in memory with `fuse.js`. This is deliberately not OpenSearch or any managed
search service — at the current scale it's free and fast. If the catalog grows into the
tens of thousands of rows, or query latency matters more, that's the point to introduce a
real search index.
