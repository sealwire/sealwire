import { createThemeCollection } from "@pierre/theming";
import { normalizeTheme } from "shiki/core";

export function createTheme({ load, ...descriptor }) {
  return {
    ...descriptor,
    load: async () => normalizeTheme((await load()).default),
  };
}

export const pierreThemes = createThemeCollection({ themes: [
  createTheme({
    name: "pierre-dark", collection: "pierre", colorScheme: "dark",
    displayName: "Pierre Dark", load: () => import("@pierre/theme/pierre-dark"),
  }),
  createTheme({
    name: "pierre-light", collection: "pierre", colorScheme: "light",
    displayName: "Pierre Light", load: () => import("@pierre/theme/pierre-light"),
  }),
] });
export const shikiThemes = createThemeCollection({ themes: [] });
export const themes = pierreThemes;
