import type {WebSite} from 'schema-dts';
// @ts-expect-error schema-dts must reject invented authored entity types.
const invalidType: WebSite = {'@type': 'GrowInventedEntity'};
void invalidType;
