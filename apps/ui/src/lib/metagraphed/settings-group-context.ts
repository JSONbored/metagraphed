import { createContext } from "react";

/** Portaled controls must close when their mounted Settings group is hidden.
 * Outside Settings, controls keep their normal behavior.
 */
export const SettingsGroupActiveContext = createContext(true);
