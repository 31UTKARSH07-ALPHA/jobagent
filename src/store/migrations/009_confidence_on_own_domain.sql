-- A mailbox on a different domain does not qualify as high confidence.
UPDATE contacts
   SET confidence = 'medium'
 WHERE confidence = 'high'
   AND id IN (
     SELECT k.id FROM contacts k JOIN companies c ON c.id = k.company_id
      WHERE substr(k.email, instr(k.email, '@') + 1) <> c.domain
        AND substr(k.email, instr(k.email, '@') + 1) NOT LIKE '%.' || c.domain
   );
