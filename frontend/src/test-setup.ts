import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
  this.querySelector<HTMLElement>(
    "input, textarea, select, button, a[href]",
  )?.focus();
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
