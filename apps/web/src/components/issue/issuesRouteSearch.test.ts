// Fork-only (jehhynes/t3code#107).
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { Route as IssuesRoute } from "../../routes/_chat.issues";

it("retains the selected issue host independently of the list host filter", () => {
  const validate = IssuesRoute.options.validateSearch;
  if (typeof validate !== "function") throw new Error("Expected a search validator");

  expect(
    validate({
      host: "github.acme.test",
      selectedHost: "github.com",
      selectedProjectId: "project-1",
      tracker: "github",
      scope: "acme/web",
      key: "107",
    }),
  ).toMatchObject({ host: "github.acme.test", selectedHost: "github.com" });
});

it.each(["123", "true", "%7B%22bad%22%3Atrue%7D"])(
  "discards a non-string selected host from matched search: %s",
  (selectedHost) => {
    const root = createRootRoute();
    const issues = createRoute({
      getParentRoute: () => root,
      path: "issues",
      validateSearch: IssuesRoute.options.validateSearch,
    });
    const router = createRouter({
      routeTree: root.addChildren([issues]),
      history: createMemoryHistory({ initialEntries: [`/issues?selectedHost=${selectedHost}`] }),
    });
    expect(router.matchRoutes(router.latestLocation).at(-1)?.search.selectedHost).toBe("");
  },
);
