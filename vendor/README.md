# Shared engine dependency

This archive is the Node distribution of `@naucto/engine` built from Frontend commit
`0940d741ef3e` on `feat/naucto-ai`. Both Backend and Naucto-AI install the identical archive.
Its manifest records the full source revision; npm's lockfile verifies archive integrity.

To update, run `npm run pack:node -w packages/engine` in the committed Frontend checkout,
replace the archive in both consumers, then run `npm install ./vendor/<archive>`.
The build script lives in `Frontend/packages/engine/scripts/pack-node.mjs`.
Do not edit bundled code: change the engine source and rebuild.
