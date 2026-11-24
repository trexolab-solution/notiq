// @vitest-environment happy-dom
/** CsvTable: numbered rows, a header, sortable columns (numbers as numbers), a cut for very long files. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CsvTable } from "./CsvTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const render = async (text: string, name = "parts.csv") => { await act(async () => { root.render(<CsvTable text={text} name={name} />); }); };
const heads = () => Array.from(document.querySelectorAll("thead th")).slice(1).map((th) => th.textContent);
const col = (c: number) => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[c + 1].textContent);
const clickHead = async (i: number) => { await act(async () => { (document.querySelectorAll("thead th button")[i] as HTMLElement).click(); }); };
const status = () => document.querySelector("[data-testid=csv-status]")!.textContent!;
const CSV = "name,qty,price\nbolt,10,1.5\nnut,9,0.25\nwasher,100,\n";

describe("CsvTable", () => {
  it("shows the header and numbered rows, and says how big it is", async () => {
    await render(CSV);
    expect(heads()).toEqual(["name", "qty", "price"]);
    expect(col(0)).toEqual(["bolt", "nut", "washer"]);
    expect(Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")!.textContent)).toEqual(["1", "2", "3"]);
    expect(status()).toContain("3 rows × 3 columns · comma separated");
  });

  it("aligns numbers to the right", async () => {
    await render(CSV);
    const cells = document.querySelectorAll("tbody tr")[0].querySelectorAll("td");
    expect(cells[1].className).not.toContain("text-right");
    expect(cells[2].className).toContain("text-right");
  });

  it("sorts by a column when its title is clicked: up, down, then back to the file's order", async () => {
    await render(CSV);
    await clickHead(1);
    expect(col(1)).toEqual(["9", "10", "100"]); // as numbers, not as text
    expect(document.querySelectorAll("thead th")[2].getAttribute("aria-sort")).toBe("ascending");
    await clickHead(1);
    expect(col(1)).toEqual(["100", "10", "9"]);
    expect(document.querySelectorAll("thead th")[2].getAttribute("aria-sort")).toBe("descending");
    await clickHead(1);
    expect(col(1)).toEqual(["10", "9", "100"]);
    expect(document.querySelectorAll("thead th")[2].getAttribute("aria-sort")).toBe("none");
    await clickHead(0);
    expect(col(0)).toEqual(["bolt", "nut", "washer"]);
  });

  it("empty cells stay last when sorting", async () => {
    await render(CSV);
    await clickHead(2);
    expect(col(2)).toEqual(["0.25", "1.5", ""]);
    await clickHead(2);
    expect(col(2)).toEqual(["1.5", "0.25", ""]);
  });

  it("the first row can be turned from the header into data", async () => {
    await render(CSV);
    const box = document.querySelector("label input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => { box.click(); });
    expect(heads()).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(col(0)).toEqual(["name", "bolt", "nut", "washer"]);
    expect(status()).toContain("4 rows");
  });

  it("a semicolon file and a tab file are read too", async () => {
    await render("a;b\n1;2\n", "x.csv");
    expect(heads()).toEqual(["a", "b"]);
    expect(status()).toContain("semicolon separated");
    await render("a\tb\n1\t2\n", "x.tsv");
    expect(status()).toContain("tab separated");
  });

  it("names a column that has no title", async () => {
    await render("a,,c\n1,2,3\n");
    expect(heads()).toEqual(["a", "Column 2", "c"]);
  });

  it("says when it shows only the first part of a long file", async () => {
    const long = ["h1,h2", ...Array.from({ length: 5003 }, (_, i) => `r${i},x`)].join("\n");
    await render(long);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(4999); // 5,000 rows shown, the header one of them
    expect(status()).toContain("Showing the first 5,000 rows");
    expect(status()).toContain("5,003 rows");
  });

  it("an empty file says so", async () => {
    await render("");
    expect(document.body.textContent).toContain("This file is empty.");
    expect(document.querySelector("table")).toBeNull();
  });
});
