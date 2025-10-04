import fetch from 'node-fetch';
import { ApiError } from './ApiError.js';

// Email validation function
export const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// HTTP-based email service that works around Render's SMTP port blocking
class EmailServiceV2 {
  constructor() {
    this.services = {
      gmail: new GmailAPIService(),
      sendgrid: new SendGridService(),
      resend: new ResendService(),
      brevo: new BrevoService()
    };
  }

  // Auto-detect email provider and use appropriate service
  async sendEmail(to, subject, htmlContent, textContent = '', userEmailConfig = null, maxRetries = 3) {
    if (!userEmailConfig || !userEmailConfig.isConfigured) {
      throw new ApiError(400, 'Email configuration is required. Please configure your email settings first.');
    }

    // Validate email address
    if (!isValidEmail(to)) {
      throw new ApiError(400, `Invalid email address: ${to}`);
    }

    const emailDomain = userEmailConfig.smtpUser.split('@')[1].toLowerCase();
    let service = null;

    // Determine which service to use based on user's email domain
    if (emailDomain.includes('gmail.com') || emailDomain.includes('googlemail.com')) {
      service = this.services.gmail;
    } else if (userEmailConfig.sendgridApiKey) {
      service = this.services.sendgrid;
    } else if (userEmailConfig.resendApiKey) {
      service = this.services.resend;
    } else {
      // Default to Brevo (free tier available)
      service = this.services.brevo;
    }

    // Try sending with retry logic
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await service.sendEmail({
          to,
          subject,
          htmlContent,
          textContent,
          fromEmail: userEmailConfig.smtpUser,
          fromName: userEmailConfig.fromName,
          userConfig: userEmailConfig
        });

        console.log(`✅ Email sent via ${service.constructor.name} to ${to} on attempt ${attempt}: ${result.messageId}`);
        
        return {
          success: true,
          messageId: result.messageId,
          to,
          subject,
          attempts: attempt,
          service: service.constructor.name
        };

      } catch (error) {
        lastError = error;
        console.error(`❌ Failed to send email via ${service.constructor.name} to ${to} (attempt ${attempt}/${maxRetries}):`, error.message);
        
        // Don't retry for authentication errors
        if (error.message.includes('authentication') || error.message.includes('unauthorized')) {
          break;
        }
        
        // Wait before retrying (exponential backoff)
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`⏳ Retrying email to ${to} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new ApiError(500, `Failed to send email after ${maxRetries} attempts: ${lastError.message}`);
  }

  // Send bulk emails with rate limiting
  async sendBulkEmails(emailList, subject, htmlTemplate, textTemplate = '', userEmailConfig = null) {
    const results = {
      sent: 0,
      failed: 0,
      errors: []
    };

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const emailData of emailList) {
      try {
        // Replace personalization variables in the template
        let personalizedHtml = htmlTemplate;
        let personalizedText = textTemplate;

        // Replace common variables
        Object.keys(emailData).forEach(key => {
          const placeholder = `{${key}}`;
          personalizedHtml = personalizedHtml.replace(new RegExp(placeholder, 'g'), emailData[key] || '');
          personalizedText = personalizedText.replace(new RegExp(placeholder, 'g'), emailData[key] || '');
        });

        await this.sendEmail(emailData.email, subject, personalizedHtml, personalizedText, userEmailConfig);
        results.sent++;
        
        // Rate limiting: wait 200ms between emails for HTTP APIs
        await delay(200);
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          email: emailData.email,
          error: error.message
        });
      }
    }

    return results;
  }
}

// Gmail API Service (OAuth 2.0)
class GmailAPIService {
  async sendEmail({ to, subject, htmlContent, textContent, fromEmail, fromName, userConfig }) {
    if (!userConfig.googleAccessToken) {
      throw new Error('Gmail OAuth access token required. Please authenticate with Google.');
    }

    const email = this.createEmailMessage({
      to,
      subject,
      htmlContent,
      textContent,
      fromEmail,
      fromName
    });

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userConfig.googleAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        raw: Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Gmail API error: ${error.error?.message || 'Unknown error'}`);
    }

    const result = await response.json();
    return { messageId: result.id };
  }

  createEmailMessage({ to, subject, htmlContent, textContent, fromEmail, fromName }) {
    const boundary = Math.random().toString(36).substr(2, 15);
    
    return [
      `From: "${fromName}" <${fromEmail}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      textContent || htmlContent.replace(/<[^>]*>/g, ''),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      htmlContent,
      '',
      `--${boundary}--`
    ].join('\r\n');
  }
}

// SendGrid Service (Paid but reliable)
class SendGridService {
  async sendEmail({ to, subject, htmlContent, textContent, fromEmail, fromName, userConfig }) {
    if (!userConfig.sendgridApiKey) {
      throw new Error('SendGrid API key required.');
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userConfig.sendgridApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: to }]
        }],
        from: {
          email: fromEmail,
          name: fromName
        },
        subject,
        content: [
          {
            type: 'text/plain',
            value: textContent || htmlContent.replace(/<[^>]*>/g, '')
          },
          {
            type: 'text/html',
            value: htmlContent
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SendGrid error: ${error}`);
    }

    return { messageId: response.headers.get('x-message-id') || `sg_${Date.now()}` };
  }
}

// Resend Service (Modern alternative)
class ResendService {
  async sendEmail({ to, subject, htmlContent, textContent, fromEmail, fromName, userConfig }) {
    if (!userConfig.resendApiKey) {
      throw new Error('Resend API key required.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userConfig.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        subject,
        html: htmlContent,
        text: textContent || htmlContent.replace(/<[^>]*>/g, '')
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Resend error: ${error.message || 'Unknown error'}`);
    }

    const result = await response.json();
    return { messageId: result.id };
  }
}

// Brevo (formerly Sendinblue) Service - Free tier available
class BrevoService {
  async sendEmail({ to, subject, htmlContent, textContent, fromEmail, fromName, userConfig }) {
    if (!userConfig.brevoApiKey) {
      throw new Error('Brevo API key required.');
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': userConfig.brevoApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: fromName,
          email: fromEmail
        },
        to: [{ email: to }],
        subject,
        htmlContent,
        textContent: textContent || htmlContent.replace(/<[^>]*>/g, '')
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Brevo error: ${error.message || 'Unknown error'}`);
    }

    const result = await response.json();
    return { messageId: result.messageId };
  }
}

// Create singleton instance
const emailServiceV2 = new EmailServiceV2();

// Export functions that match the original API
export const sendEmail = async (to, subject, htmlContent, textContent = '', fromEmail = null, fromName = null, userEmailConfig = null, maxRetries = 3) => {
  return await emailServiceV2.sendEmail(to, subject, htmlContent, textContent, userEmailConfig, maxRetries);
};

export const sendBulkEmails = async (emailList, subject, htmlTemplate, textTemplate = '', fromEmail = null, fromName = null, userEmailConfig = null) => {
  return await emailServiceV2.sendBulkEmails(emailList, subject, htmlTemplate, textTemplate, userEmailConfig);
};

// Re-export template function (unchanged)
export { createEmailTemplate } from './emailService.js';

export default {
  sendEmail,
  sendBulkEmails,
  createEmailTemplate,
  isValidEmail
};
