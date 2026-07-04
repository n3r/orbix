import { createBrowserRouter, Navigate } from "react-router";
import RequireProfile from "./routes/RequireProfile";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import ProfilesPage from "./pages/ProfilesPage";
import HomePage from "./pages/HomePage";
import TvHomePage from "./pages/TvHomePage";
import TvGuidePage from "./pages/TvGuidePage";
import TvChannelPage from "./pages/TvChannelPage";
import LibraryPage from "./pages/LibraryPage";
import SearchPage from "./pages/SearchPage";
import WishlistPage from "./pages/WishlistPage";
import TitlePage from "./pages/TitlePage";
import FixMatchPage from "./pages/FixMatchPage";
import AdminLibrariesPage from "./pages/AdminLibrariesPage";
import AdminSettingsPage from "./pages/AdminSettingsPage";
import AccountLayout from "./pages/account/AccountLayout";
import AccountOverview from "./pages/account/AccountOverview";
import AccountMenuPage from "./pages/account/AccountMenuPage";
import AccountTvPage from "./pages/account/AccountTvPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/profiles", element: <ProfilesPage /> },
  {
    element: <RequireProfile />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/tv", element: <TvHomePage /> },
      { path: "/tv/guide", element: <TvGuidePage /> },
      { path: "/tv/channel/:id", element: <TvChannelPage /> },
      { path: "/library/:libraryId", element: <LibraryPage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/wishlist", element: <WishlistPage /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/title/:id/fix", element: <FixMatchPage /> },
      {
        path: "/account",
        element: <AccountLayout />,
        children: [
          { index: true, element: <AccountOverview /> },
          { path: "menu", element: <AccountMenuPage /> },
          { path: "tv", element: <AccountTvPage /> },
          { path: "library", element: <AdminLibrariesPage /> },
          { path: "settings", element: <AdminSettingsPage /> },
        ],
      },
      { path: "/admin/libraries", element: <Navigate to="/account/library" replace /> },
      { path: "/admin/settings", element: <Navigate to="/account/settings" replace /> },
    ],
  },
]);
