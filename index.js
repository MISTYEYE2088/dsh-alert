# Host half of dsh-alert.
#
# The Cordis Loader imports every row in the composed host tree, so a
# browser-owned plugin still needs a valid Node entry: package.json points
# `main` and `exports["."]` here. Deleting this file stops the profile from
# booting at all ("ERR_MODULE_NOT_FOUND ... dsh-alert/index.js") before the web
# URL is printed.
#
# All behavior lives in client.js (see the header there for the data path).
# Nothing is registered on the Host side: the alert must follow the browser tab
# the user is actually looking at, and only the browser half knows whether that
# tab is visible, audible, or allowed to post notifications.
export const name = 'dsh-alert'

export function apply() {}
