import { $ } from "../core/dom.js";
import { bindPopover } from "../layout/popovers.js";

export function bindRonixMenu() {
  const menu = $("#ronix-menu");
  const controller = bindPopover($("#ronix-menu-trigger"), menu, {
    placement: "top",
    onOpen: () => {
      const user = globalThis.ronixAccess?.user;
      $("#ronix-menu-user").textContent = user?.name || user?.username || "";
      $("#ronix-menu-user").hidden = !$("#ronix-menu-user").textContent;
      $("#logout-separator").hidden = $("#logout").hidden;
    },
  });
  // Close before the existing action handlers open their dialogs.
  menu.addEventListener("click", (event) => {
    if (event.target.closest("[role=menuitem]")) controller.close();
  }, true);
}
