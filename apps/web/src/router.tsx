import { createBrowserRouter, Navigate } from "react-router";
import RequireProfile from "./routes/RequireProfile";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import ProfilesPage from "./pages/ProfilesPage";
import HomePage from "./pages/HomePage";
import LibraryPage from "./pages/LibraryPage";
import SearchPage from "./pages/SearchPage";
import TitlePage from "./pages/TitlePage";
import FixMatchPage from "./pages/FixMatchPage";
import AdminLibrariesPage from "./pages/AdminLibrariesPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AccountLayout from "./pages/account/AccountLayout";
import AccountOverview from "./pages/account/AccountOverview";
import AccountMenuPage from "./pages/account/AccountMenuPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/profiles", element: <ProfilesPage /> },
  {
    element: <RequireProfile />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/library/:libraryId", element: <LibraryPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/title/:id/fix", element: <FixMatchPage /> },
      {
        path: "/account",
        element: <AccountLayout />,
        children: [
          { index: true, element: <AccountOverview /> },
          { path: "menu", element: <AccountMenuPage /> },
          { path: "library", element: <AdminLibrariesPage /> },
          { path: "settings", element: <AdminSettingsPage /> },
        ],
      },
      { path: "/admin/libraries", element: <Navigate to="/account/library" replace /> },
      { path: "/admin/settings", element: <Navigate to="/account/settings" replace /> },
    ],
  },
]);
