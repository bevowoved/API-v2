export interface MenuSection {
  title: string;
  items: string[];
}

export interface RestaurantMenu {
  id: string;
  name: string;
  page: number;
  sections: MenuSection[];
}

export interface DailyMenu {
  date: string;
  pdfUrl: string;
  restaurants: RestaurantMenu[];
}

export const dailyMenuResponseSchema = {
  type: "object",
  properties: {
    date: { type: "string" },
    pdfUrl: { type: "string" },
    restaurants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          page: { type: "number" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                items: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["title", "items"],
            },
          },
        },
        required: ["id", "name", "page", "sections"],
      },
    },
  },
  required: ["date", "pdfUrl", "restaurants"],
};
