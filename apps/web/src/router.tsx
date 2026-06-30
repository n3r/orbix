import { createBrowserRouter } from "react-router";
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

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/profiles", element: <ProfilesPage /> },
  {
    element: <RequireProfile />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/library/:sectionId", element: <LibraryPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/title/:id/fix", element: <FixMatchPage /> },
      { path: "/admin/libraries", element: <AdminLibrariesPage /> },
      { path: "/admin/settings", element: <AdminSettingsPage /> },
    ],
  },
]);
