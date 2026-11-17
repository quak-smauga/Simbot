import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Każda strona techniczna może mieć status implementacji i listę plików źródłowych (renderowane przez PageTitle).
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        status: z.enum(["implemented", "partial", "experimental", "planned", "deprecated"]).optional(),
        sources: z.array(z.string()).optional(),
      }),
    }),
  }),
};
