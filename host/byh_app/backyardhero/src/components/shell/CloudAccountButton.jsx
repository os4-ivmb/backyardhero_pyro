import React from "react";
import { FiLogIn, FiUser } from "react-icons/fi";

import { Button } from "@/design";
import { ACCOUNT_URL, SIGN_IN_URL } from "@/util/useCloudSession";

// Top-bar account control for the cloud builder. The sign-in and account
// pages belong to the gateway at the site root, outside this app's /builder
// basePath, so these are full-page navigations rather than Next links.
export default function CloudAccountButton({ session }) {
  if (session.status === "signed_out") {
    return (
      <Button
        variant="primary"
        size="sm"
        leading={<FiLogIn />}
        onClick={() => window.location.assign(SIGN_IN_URL)}
      >
        Sign in
      </Button>
    );
  }
  if (session.status === "signed_in") {
    return (
      <Button
        variant="ghost"
        size="sm"
        leading={<FiUser />}
        onClick={() => window.location.assign(ACCOUNT_URL)}
        title={session.email ? `Signed in as ${session.email}` : "Your account"}
      >
        <span className="hidden lg:inline">{session.email || "Account"}</span>
      </Button>
    );
  }
  return null;
}
