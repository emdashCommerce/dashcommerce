/**
 * EmDash Live Content Collections
 *
 * Registers emdash's loader under the `_emdash` live collection key.
 * This is a hard requirement for `getEmDashCollection()` and
 * `getEmDashEntry()` to return anything — without the loader,
 * `astro:content` has no data source for the collection and the helpers
 * silently return empty arrays.
 */

import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
