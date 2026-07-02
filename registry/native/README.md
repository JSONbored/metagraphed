# Native Snapshots

Native snapshots are generated from decoded Bittensor/Subtensor data and provide all-subnet coverage.

Regenerate the Finney snapshot with:

```bash
npm run sync:subnets
```

Preview source counts and netuid changes without writing:

```bash
npm run sync:subnets:dry-run
```

The current implementation uses `uvx --from bittensor==10.4.0` to run the official Bittensor Python SDK without committing Python dependencies into this repository.
