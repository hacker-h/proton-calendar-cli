#!/usr/bin/env node

import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>browser-smoke</title><h1>ok</h1>");

  const title = await page.title();
  const heading = await page.locator("h1").textContent();
  if (title !== "browser-smoke" || heading !== "ok") {
    throw new Error(`Unexpected browser smoke result: title=${title} heading=${heading}`);
  }

  console.log("browser-smoke: chromium launched and rendered local content");
} finally {
  await browser.close();
}
