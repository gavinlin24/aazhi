export interface Found {
  attrs: Record<string, string>;
  text: string;
}

// Reads the page the way a browser would find elements, with the Workers
// runtime's own HTML parser, so assertions do not hinge on attribute order or
// whitespace. Text is the element's own text plus its descendants', with
// entities still encoded (HTMLRewriter does not decode them).
export async function select(html: string, selector: string): Promise<Found[]> {
  const found: Found[] = [];
  const open: Found[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        const el: Found = { attrs: Object.fromEntries(element.attributes), text: "" };
        found.push(el);
        // Void elements like <meta> have no end tag and refuse the handler.
        try {
          element.onEndTag(() => {
            open.splice(open.indexOf(el), 1);
          });
        } catch {
          return;
        }
        open.push(el);
      },
      text(chunk) {
        for (const el of open) el.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  for (const el of found) el.text = el.text.replace(/\s+/g, " ").trim();
  return found;
}

export async function one(html: string, selector: string): Promise<Found> {
  const all = await select(html, selector);
  if (all.length !== 1) throw new Error(`expected one ${selector}, found ${all.length}`);
  return all[0]!;
}

export async function textOf(html: string, selector: string): Promise<string> {
  return (await one(html, selector)).text;
}
