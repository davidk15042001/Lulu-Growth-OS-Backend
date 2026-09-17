-- The Company Brain follows one permanent product mission. Workspaces provide
-- facts, context, connections and budget authority; they do not replace the
-- global North Star with a user-defined objective.

ALTER TABLE company_brain_missions
  ALTER COLUMN north_star SET DEFAULT 'Continuously build a trusted global brand at maximum sustainable speed and make the company the number-one choice in its category worldwide.';

UPDATE company_brain_missions
SET north_star='Continuously build a trusted global brand at maximum sustainable speed and make the company the number-one choice in its category worldwide.'
WHERE north_star IS DISTINCT FROM 'Continuously build a trusted global brand at maximum sustainable speed and make the company the number-one choice in its category worldwide.';
