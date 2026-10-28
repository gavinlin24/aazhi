// Placeholder so wrangler and the Workers test pool have an entry point to
// load; the interaction router replaces it.
export default {
  async fetch() {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
