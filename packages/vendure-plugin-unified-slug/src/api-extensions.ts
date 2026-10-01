import gql from 'graphql-tag';

/**
 * Prefixed `unifiedSlug`, since the Admin schema is shared with core (`slugForEntity`) and every
 * other plugin. Same permission as core's query: it reads nothing an admin cannot and writes nothing.
 */
export const adminApiExtensions: ReturnType<typeof gql> = gql`
  input UnifiedSlugGenerateInput {
    "'Product' or 'Collection'. Anything else is a UserInputError."
    entityName: String!
    "The name to build the slug from."
    name: String!
    "The entity being updated, excluded from the uniqueness check so it never collides with itself."
    entityId: ID
    "Form values the slug strategy asked for (see unifiedSlugSettings.watchFormFields), passed to it verbatim."
    context: JSON
  }

  type UnifiedSlugSettings {
    "Paths in the detail form whose values the slug strategy needs. The dashboard field sends them as context."
    watchFormFields: [String!]!
  }

  extend type Query {
    """
    The slug the configured strategy gives the entity, made unique the way core's slugForEntity does.
    Empty string when the name yields nothing — a slug is never invented.
    """
    unifiedSlugGenerate(input: UnifiedSlugGenerateInput!): String!
    unifiedSlugSettings: UnifiedSlugSettings!
  }
`;
