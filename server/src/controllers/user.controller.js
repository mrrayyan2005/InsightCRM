import { Campaign } from "../models/campaign.model.js";
import { Segment } from "../models/segment.model.js";
import { CommunicationLog } from "../models/comunicationLog.model.js";
import { Customer } from "../models/customer.model.js";
import { User } from "../models/user.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { sendEmail, sendBulkEmails, createEmailTemplate, isValidEmail } from "../utils/emailService.js";

// Helper to build MongoDB query from rules
const buildSegmentQuery = (rules) => {
  // Handle both direct rules object and segment document format
  const segmentRules = rules.rules ? rules : rules.rules;

  const query = {};
  const getFieldPath = (field) => {
    const fieldMap = {
      total_spent: "stats.total_spent",
      order_count: "stats.order_count",
      last_purchase: "stats.last_purchase",
      city: "address.city",
      is_active: "is_active",
    };
    return fieldMap[field] || field;
  };

  const conditions = segmentRules.rules.map((rule) => {
    const fieldPath = getFieldPath(rule.field);
    let value = rule.value;

    // Special handling for last_purchase (convert days to date)
    if (rule.field === "last_purchase") {
      const daysAgo = parseInt(value);
      if (!isNaN(daysAgo)) {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        value = date;
      }
    }

    // Special handling for boolean fields
    if (rule.field === "is_active") {
      value = value === "true" || value === true;
    }

    switch (rule.operator) {
      case ">":
        return { [fieldPath]: { $gt: value } };
      case "<":
        return { [fieldPath]: { $lt: value } };
      case ">=":
        return { [fieldPath]: { $gte: value } };
      case "<=":
        return { [fieldPath]: { $lte: value } };
      case "==":
        return { [fieldPath]: { $eq: value } };
      case "!=":
        return { [fieldPath]: { $ne: value } };
      case "contains":
        return { [fieldPath]: { $regex: value, $options: "i" } };
      default:
        return {};
    }
  });

  if (segmentRules.combinator === "and" || segmentRules.condition === "AND") {
    query.$and = conditions;
  } else {
    query.$or = conditions;
  }

  return query;
};

// Create segment
const createSegment = asyncHandler(async (req, res) => {
  const { name, description, rules } = req.body;

  // 1. Validate input
  if (!name || !rules?.rules || rules.rules.length === 0) {
    throw new ApiError(400, "Name and at least one rule are required");
  }

  // 2. Build query and estimate count
  const query = buildSegmentQuery(rules);
  const estimatedCount = await Customer.countDocuments(query);

  // 3. Create segment linked to authenticated user
  const segment = await Segment.create({
    name,
    description,
    rules,
    estimated_count: estimatedCount,
    created_by: req.user._id,
    is_dynamic: true,
  });

  res
    .status(201)
    .json(new ApiResponse(201, segment, "Segment created successfully"));
});

// Get segments for current user
const getUserSegments = asyncHandler(async (req, res) => {
  const segments = await Segment.find({ created_by: req.user._id })
    .sort({ createdAt: -1 })
    .lean();

  // Transform the rules for better frontend display
  const transformedSegments = segments.map(segment => ({
    ...segment,
    rules: {
      condition: segment.rules.condition,
      rules: segment.rules.rules.map((rule) => ({
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        value_type: rule.value_type,
      })),
    },
  }));

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        transformedSegments,
        "Segments fetched successfully"
      )
    );
});

// Estimate segment size
const estimateSegment = asyncHandler(async (req, res) => {
  const { rules } = req.body;

  if (!rules?.rules || rules.rules.length === 0) {
    throw new ApiError(400, "At least one rule is required");
  }

  const query = buildSegmentQuery(rules);

  const count = await Customer.countDocuments(query);

  res
    .status(200)
    .json(new ApiResponse(200, { count }, "Segment estimated successfully"));
});

// Create campaign
const createCampaign = asyncHandler(async (req, res) => {
  const { name, segmentId, template } = req.body;

  // 1. Validate input
  if (!name || !segmentId || !template?.subject || !template?.body) {
    throw new ApiError(400, "Name, segment ID, and template are required");
  }

  // 2. Check if user has configured email settings
  const user = await User.findById(req.user._id);
  if (!user.emailConfig || !user.emailConfig.isConfigured) {
    throw new ApiError(400, "Email configuration required. Please configure your email settings before creating campaigns.");
  }

  // 2. Verify segment belongs to user and has rules
  const segment = await Segment.findOne({
    _id: segmentId,
    created_by: req.user._id,
  });

  if (!segment) {
    throw new ApiError(404, "Segment not found or access denied");
  }

  if (!segment.rules || segment.rules.rules.length === 0) {
    throw new ApiError(400, "Segment has no rules defined");
  }

  // 3. Verify the segment actually matches customers
  const query = buildSegmentQuery(segment.rules);
  const customerCount = await Customer.countDocuments(query);

  if (customerCount === 0) {
    throw new ApiError(
      400,
      "Segment matches 0 customers - cannot create campaign"
    );
  }

  // 4. Create campaign with accurate initial count
  const campaign = await Campaign.create({
    name,
    segment_id: segmentId,
    template,
    created_by: req.user._id,
    status: "draft",
    stats: {
      total_recipients: customerCount, // Use actual count from query
    },
  });

  // 5. Process campaign in background with proper error handling
  processCampaignInBackground(campaign._id).catch(error => {
    console.error("❌ Background campaign processing failed:", error);
  });

  res
    .status(201)
    .json(new ApiResponse(201, campaign, "Campaign created successfully"));
});

// Get user's campaigns
const getUserCampaigns = asyncHandler(async (req, res) => {
  const campaigns = await Campaign.find({ created_by: req.user._id })
    .populate("segment_id", "name estimated_count")
    .sort("-created_at");

  res
    .status(200)
    .json(new ApiResponse(200, campaigns, "Campaigns fetched successfully"));
});

// Delivery Receipt API
const updateDeliveryStatus = asyncHandler(async (req, res) => {
  const { message_id, status, timestamp } = req.body;

  if (!message_id || !status) {
    throw new ApiError(400, "Message ID and status are required");
  }

  const log = await CommunicationLog.findOne({ message_id });
  if (!log) {
    throw new ApiError(404, "Communication log not found");
  }

  // Update status and relevant timestamp
  const update = { status };
  switch (status) {
    case "delivered":
      update.delivered_at = timestamp || new Date();
      break;
    case "opened":
      update.opened_at = timestamp || new Date();
      break;
    case "clicked":
      update.clicked_at = timestamp || new Date();
      break;
  }

  await CommunicationLog.findByIdAndUpdate(log._id, update);

  res.status(200).json(new ApiResponse(200, null, "Delivery status updated successfully"));
});

// Background processing with real email sending - Production Ready
const processCampaignInBackground = async (campaignId) => {
  let campaign;
  const startTime = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout
  
  try {
    console.log(`📧 [${campaignId}] Starting background campaign processing...`);
    
    campaign = await Campaign.findById(campaignId)
      .populate("segment_id")
      .populate("created_by");

    if (!campaign) {
      console.error(`❌ [${campaignId}] Campaign not found`);
      return;
    }

    console.log(`📧 [${campaignId}] Starting email campaign: ${campaign.name}`);

    // Check timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error("Campaign processing timeout - initial setup took too long");
    }

    // 1. Get customers matching segment using the same query logic as preview
    console.log(`🔍 [${campaignId}] Building customer query...`);
    const query = buildSegmentQuery(campaign.segment_id.rules);
    const customers = await Customer.find(query).lean();
    console.log(`👥 [${campaignId}] Found ${customers.length} customers`);

    // 2. Update campaign status with exact count
    campaign.status = "processing";
    campaign.stats.total_recipients = customers.length;
    campaign.stats.started_at = new Date();
    await campaign.save();
    console.log(`✅ [${campaignId}] Campaign status updated to processing`);

    // 3. Prepare email data for bulk sending
    const emailList = [];
    let validEmails = 0;
    let invalidEmails = 0;

    customers.forEach(customer => {
      if (isValidEmail(customer.email)) {
        emailList.push({
          email: customer.email,
          name: customer.name,
          total_spent: customer.stats?.total_spent || 0,
          orders_count: customer.stats?.order_count || 0,
          city: customer.address?.city || '',
          phone: customer.phone || ''
        });
        validEmails++;
      } else {
        console.log(`❌ Invalid email for customer ${customer.name}: ${customer.email}`);
        invalidEmails++;
      }
    });

    console.log(`📊 Email validation: ${validEmails} valid, ${invalidEmails} invalid`);

    // 4. Create communication logs first
    const logPromises = customers.map((customer) => {
      const message_id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${customer._id}`;
      const isValidEmailAddr = isValidEmail(customer.email);
      
      return CommunicationLog.create({
        campaign_id: campaign._id,
        customer_id: customer._id,
        status: isValidEmailAddr ? "queued" : "failed",
        message_id,
        sent_at: new Date(),
        ...(!isValidEmailAddr && { failure_reason: `Invalid email: ${customer.email}` }),
      });
    });

    const logResults = await Promise.allSettled(logPromises);
    const createdLogs = logResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    console.log(`📝 Created ${createdLogs.length} communication logs`);

    // 5. Send actual emails using the campaign template with tracking - Production Safe
    let emailResults = { sent: 0, failed: 0, errors: [] };
    
    if (emailList.length > 0) {
      console.log(`📤 [${campaignId}] Sending emails to ${emailList.length} recipients...`);
      
      // Get sender name from email configuration (not user account name)
      const senderName = campaign.created_by.emailConfig?.fromName || 'Company CRM';
      
      // Check if email config is valid
      if (!campaign.created_by.emailConfig || !campaign.created_by.emailConfig.isConfigured) {
        throw new Error("Email configuration is not properly set up");
      }
      
      // Send emails individually with tracking and timeout protection
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const emailTimeout = 30000; // 30 seconds per email
      
      for (let i = 0; i < emailList.length; i++) {
        const emailData = emailList[i];
        
        // Check overall timeout periodically
        if (Date.now() - startTime > TIMEOUT_MS) {
          console.log(`⏰ [${campaignId}] Campaign timeout reached, stopping at ${i}/${emailList.length} emails`);
          break;
        }
        
        try {
          console.log(`📧 [${campaignId}] Sending email ${i + 1}/${emailList.length} to ${emailData.email}`);
          
          // Find the corresponding log for this customer
          const customerLog = createdLogs.find(log => 
            log.customer_id.toString() === customers.find(c => c.email === emailData.email)?._id.toString()
          );
          
          if (customerLog) {
            // Create HTML email template with tracking
            const htmlTemplate = createEmailTemplate(
              campaign.template.subject, 
              campaign.template.body,
              emailData.name,
              customerLog.message_id,
              process.env.SERVER_URL || 'https://insightcrm.onrender.com',
              campaign.created_by.emailConfig.fromName || 'Your Company'
            );

            // Replace personalization variables
            let personalizedHtml = htmlTemplate;
            let personalizedText = campaign.template.body;

            Object.keys(emailData).forEach(key => {
              const placeholder = `{${key}}`;
              personalizedHtml = personalizedHtml.replace(new RegExp(placeholder, 'g'), emailData[key] || '');
              personalizedText = personalizedText.replace(new RegExp(placeholder, 'g'), emailData[key] || '');
            });

            // Send email with timeout protection
            const emailPromise = sendEmail(
              emailData.email,
              campaign.template.subject,
              personalizedHtml,
              personalizedText,
              campaign.created_by.emailConfig.smtpUser,
              senderName,
              campaign.created_by.emailConfig
            );
            
            // Add timeout to email sending
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Email sending timeout')), emailTimeout);
            });
            
            await Promise.race([emailPromise, timeoutPromise]);
            
            emailResults.sent++;
            console.log(`✅ [${campaignId}] Email sent successfully to ${emailData.email}`);
            
            // Update log status to sent
            await CommunicationLog.findByIdAndUpdate(customerLog._id, {
              status: 'sent',
              sent_at: new Date()
            }).catch(err => console.error(`❌ Failed to update log for ${emailData.email}:`, err.message));
            
            // Rate limiting: wait between emails (production safe)
            await delay(200); // Increased delay for production stability
          }
          
        } catch (error) {
          console.error(`❌ [${campaignId}] Failed to send email to ${emailData.email}:`, error.message);
          emailResults.failed++;
          emailResults.errors.push({
            email: emailData.email,
            error: error.message
          });
          
          // Update communication log for failed email
          const customerLog = createdLogs.find(log => 
            log.customer_id.toString() === customers.find(c => c.email === emailData.email)?._id.toString()
          );
          
          if (customerLog) {
            await CommunicationLog.findByIdAndUpdate(customerLog._id, {
              status: 'failed',
              failure_reason: error.message
            }).catch(err => console.error(`❌ Failed to update failed log:`, err.message));
          }
        }
        
        // Update campaign progress every 10 emails
        if ((i + 1) % 10 === 0) {
          await Campaign.findByIdAndUpdate(campaignId, {
            'stats.sent': emailResults.sent,
            'stats.failed': emailResults.failed,
            'stats.progress': Math.round(((i + 1) / emailList.length) * 100)
          }).catch(err => console.error(`❌ Failed to update campaign progress:`, err.message));
          
          console.log(`📊 [${campaignId}] Progress: ${i + 1}/${emailList.length} (${emailResults.sent} sent, ${emailResults.failed} failed)`);
        }
      }

      console.log(`✅ [${campaignId}] Email campaign finished: ${emailResults.sent} sent, ${emailResults.failed} failed`);
      
      // Log any email errors
      if (emailResults.errors.length > 0) {
        console.log(`📋 [${campaignId}] Email errors summary:`, emailResults.errors.slice(0, 5));
      }
    } else {
      console.log(`⚠️ [${campaignId}] No valid emails to send`);
    }

    // 6. Update communication logs based on email results
    for (const errorInfo of emailResults.errors) {
      const customer = customers.find(c => c.email === errorInfo.email);
      if (customer) {
        await CommunicationLog.updateOne(
          { campaign_id: campaign._id, customer_id: customer._id },
          { 
            status: "failed", 
            failure_reason: errorInfo.error,
            delivered_at: null 
          }
        );
      }
    }

    // Update successful emails to "delivered" status
    const successfulEmails = emailList.slice(0, emailResults.sent);
    for (const emailData of successfulEmails) {
      const customer = customers.find(c => c.email === emailData.email);
      if (customer) {
        await CommunicationLog.updateOne(
          { campaign_id: campaign._id, customer_id: customer._id },
          { 
            status: "delivered", 
            delivered_at: new Date() 
          }
        );
      }
    }

    // 7. Calculate real stats from communication logs
    const sentCount = await CommunicationLog.countDocuments({ 
      campaign_id: campaign._id, 
      status: { $in: ['sent', 'delivered', 'opened', 'clicked'] }
    });
    
    const deliveredCount = await CommunicationLog.countDocuments({ 
      campaign_id: campaign._id, 
      $or: [
        { delivered_at: { $exists: true } },
        { status: { $in: ['delivered', 'opened', 'clicked'] } }
      ]
    });
    
    const openedCount = await CommunicationLog.countDocuments({ 
      campaign_id: campaign._id, 
      $or: [
        { opened_at: { $exists: true } },
        { status: { $in: ['opened', 'clicked'] } }
      ]
    });
    
    const clickedCount = await CommunicationLog.countDocuments({ 
      campaign_id: campaign._id, 
      $or: [
        { clicked_at: { $exists: true } },
        { status: 'clicked' }
      ]
    });

    // 8. Finalize campaign with real stats from communication logs
    campaign.status = "completed";
    campaign.stats.sent = sentCount;
    campaign.stats.failed = emailResults.failed + invalidEmails;
    campaign.stats.delivered = deliveredCount;
    campaign.stats.opened = openedCount;
    campaign.stats.clicked = clickedCount;
    campaign.stats.delivery_rate = customers.length > 0 ? (deliveredCount / customers.length) * 100 : 0;
    campaign.stats.open_rate = deliveredCount > 0 ? (openedCount / deliveredCount) * 100 : 0;
    campaign.stats.click_rate = openedCount > 0 ? (clickedCount / openedCount) * 100 : 0;
    
    await campaign.save();

    console.log(`🎉 Campaign completed: ${campaign.name}`);
    console.log(`📈 Final stats: ${emailResults.sent} sent, ${openedCount} opened, ${clickedCount} clicked`);

  } catch (error) {
    console.error("❌ Campaign processing failed:", error);
    await Campaign.findByIdAndUpdate(campaignId, {
      status: "failed",
      "stats.failure_reason": error.message,
    });
  }
};

const getCommuniactionLog = asyncHandler(async (req, res) => {
  const { campaignId } = req.query;

  if (!campaignId) {
    throw new ApiError(400, "Campaign ID is required");
  }

  const logs = await CommunicationLog.find({ campaign_id: campaignId })
    .populate({
      path: "customer_id",
      select: "name email phone address",
      model: Customer,
    })
    .sort({ sent_at: -1 });

  // Transform the data to flatten customer info
  const transformedLogs = logs.map((log) => {
    const logObj = log.toObject();
    return {
      ...logObj,
      customer: logObj.customer_id,
      customer_id: undefined, // Remove the nested customer_id
    };
  });

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        transformedLogs,
        "Communication logs fetched successfully"
      )
    );
});

// Get detailed segment preview
const getSegmentPreview = asyncHandler(async (req, res) => {
  const { rules } = req.body;

  if (!rules?.rules || rules.rules.length === 0) {
    throw new ApiError(400, "At least one rule is required");
  }

  const query = buildSegmentQuery(rules);

  // Get total count
  const totalCount = await Customer.countDocuments(query);

  // Get sample customers (up to 5)
  const sampleCustomers = await Customer.find(query)
    .select('name email stats demographics address')
    .limit(5)
    .lean();

  // Get gender distribution
  const genderDistribution = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: "$demographics.gender",
        count: { $sum: 1 }
      }
    }
  ]);

  // Get age group distribution
  const ageGroups = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          $switch: {
            branches: [
              { case: { $lt: ["$demographics.age", 18] }, then: "Under 18" },
              { case: { $lt: ["$demographics.age", 25] }, then: "18-24" },
              { case: { $lt: ["$demographics.age", 35] }, then: "25-34" },
              { case: { $lt: ["$demographics.age", 45] }, then: "35-44" },
              { case: { $lt: ["$demographics.age", 55] }, then: "45-54" },
              { case: { $lt: ["$demographics.age", 65] }, then: "55-64" }
            ],
            default: "65+"
          }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  // Get occupation distribution
  const occupationDistribution = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: "$demographics.occupation",
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 5 }
  ]);

  // Get city distribution
  const cityDistribution = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: "$address.city",
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 5 }
  ]);

  // Get spending statistics
  const spendingStats = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        avgSpent: { $avg: "$stats.total_spent" },
        maxSpent: { $max: "$stats.total_spent" },
        minSpent: { $min: "$stats.total_spent" },
        totalSpent: { $sum: "$stats.total_spent" }
      }
    }
  ]);

  // Get activity statistics
  const activityStats = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        avgOrders: { $avg: "$stats.order_count" },
        activeCustomers: {
          $sum: { $cond: [{ $eq: ["$is_active", true] }, 1, 0] }
        }
      }
    }
  ]);

  // Get purchase frequency distribution
  const purchaseFrequency = await Customer.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          $switch: {
            branches: [
              { case: { $eq: ["$stats.order_count", 0] }, then: "No Orders" },
              { case: { $lte: ["$stats.order_count", 1] }, then: "1 Order" },
              { case: { $lte: ["$stats.order_count", 3] }, then: "2-3 Orders" },
              { case: { $lte: ["$stats.order_count", 5] }, then: "4-5 Orders" }
            ],
            default: "5+ Orders"
          }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  res.status(200).json(
    new ApiResponse(200, {
      totalCount,
      sampleCustomers,
      demographics: {
        gender: genderDistribution.map(d => ({ gender: d._id || 'Unknown', count: d.count })),
        ageGroups: ageGroups.map(a => ({ ageGroup: a._id, count: a.count })),
        occupation: occupationDistribution.map(o => ({ occupation: o._id || 'Unknown', count: o.count }))
      },
      cityDistribution: cityDistribution.map(c => ({ city: c._id || 'Unknown', count: c.count })),
      spendingStats: spendingStats[0] || {
        avgSpent: 0,
        maxSpent: 0,
        minSpent: 0,
        totalSpent: 0
      },
      activityStats: activityStats[0] || {
        avgOrders: 0,
        activeCustomers: 0
      },
      purchaseFrequency: purchaseFrequency.map(p => ({ frequency: p._id, count: p.count }))
    }, "Segment preview generated successfully")
  );
});

// Delete campaign
const deleteCampaign = asyncHandler(async (req, res) => {
  const { campaignId } = req.params;

  if (!campaignId) {
    throw new ApiError(400, "Campaign ID is required");
  }

  // Find campaign and verify ownership
  const campaign = await Campaign.findOne({
    _id: campaignId,
    created_by: req.user._id
  });

  if (!campaign) {
    throw new ApiError(404, "Campaign not found or access denied");
  }

  // Delete associated communication logs
  await CommunicationLog.deleteMany({ campaign_id: campaignId });

  // Delete the campaign
  await Campaign.findByIdAndDelete(campaignId);

  res
    .status(200)
    .json(new ApiResponse(200, null, "Campaign deleted successfully"));
});

// Get user's email settings
const getEmailSettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('emailConfig');
  
  // Don't return the password for security
  const emailConfig = user.emailConfig ? {
    smtpHost: user.emailConfig.smtpHost,
    smtpPort: user.emailConfig.smtpPort,
    smtpUser: user.emailConfig.smtpUser,
    fromName: user.emailConfig.fromName,
    isConfigured: user.emailConfig.isConfigured
  } : {
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUser: "",
    fromName: "",
    isConfigured: false
  };

  res
    .status(200)
    .json(new ApiResponse(200, emailConfig, "Email settings fetched successfully"));
});

// Update user's email settings
const updateEmailSettings = asyncHandler(async (req, res) => {
  const { smtpHost, smtpPort, smtpUser, smtpPassword, fromName } = req.body;

  // Validate required fields
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword || !fromName) {
    throw new ApiError(400, "All email configuration fields are required");
  }

  // Validate email format
  if (!isValidEmail(smtpUser)) {
    throw new ApiError(400, "Invalid email format for SMTP user");
  }

  // Update user's email configuration
  const user = await User.findByIdAndUpdate(
    req.user._id,
    {
      emailConfig: {
        smtpHost,
        smtpPort: parseInt(smtpPort),
        smtpUser,
        smtpPassword, // In production, encrypt this
        fromName,
        isConfigured: true
      }
    },
    { new: true }
  ).select('emailConfig');

  // Return config without password
  const responseConfig = {
    smtpHost: user.emailConfig.smtpHost,
    smtpPort: user.emailConfig.smtpPort,
    smtpUser: user.emailConfig.smtpUser,
    fromName: user.emailConfig.fromName,
    isConfigured: user.emailConfig.isConfigured
  };

  res
    .status(200)
    .json(new ApiResponse(200, responseConfig, "Email settings updated successfully"));
});

// Refresh campaign stats from communication logs
const refreshCampaignStats = asyncHandler(async (req, res) => {
  const { campaignId } = req.params;

  // Find campaign and verify ownership
  const campaign = await Campaign.findOne({
    _id: campaignId,
    created_by: req.user._id
  });

  if (!campaign) {
    throw new ApiError(404, "Campaign not found or access denied");
  }

  // Calculate real stats from communication logs
  const sentCount = await CommunicationLog.countDocuments({ 
    campaign_id: campaign._id, 
    status: { $in: ['sent', 'delivered', 'opened', 'clicked'] }
  });
  
  const deliveredCount = await CommunicationLog.countDocuments({ 
    campaign_id: campaign._id, 
    $or: [
      { delivered_at: { $exists: true } },
      { status: { $in: ['delivered', 'opened', 'clicked'] } }
    ]
  });
  
  const openedCount = await CommunicationLog.countDocuments({ 
    campaign_id: campaign._id, 
    $or: [
      { opened_at: { $exists: true } },
      { status: { $in: ['opened', 'clicked'] } }
    ]
  });
  
  const clickedCount = await CommunicationLog.countDocuments({ 
    campaign_id: campaign._id, 
    $or: [
      { clicked_at: { $exists: true } },
      { status: 'clicked' }
    ]
  });

  // Update campaign stats
  campaign.stats.sent = sentCount;
  campaign.stats.delivered = deliveredCount;
  campaign.stats.opened = openedCount;
  campaign.stats.clicked = clickedCount;
  campaign.stats.delivery_rate = campaign.stats.total_recipients > 0 ? (deliveredCount / campaign.stats.total_recipients) * 100 : 0;
  campaign.stats.open_rate = deliveredCount > 0 ? (openedCount / deliveredCount) * 100 : 0;
  campaign.stats.click_rate = openedCount > 0 ? (clickedCount / openedCount) * 100 : 0;
  
  await campaign.save();

  console.log(`📊 Campaign stats refreshed: ${sentCount} sent, ${openedCount} opened, ${clickedCount} clicked`);

  res
    .status(200)
    .json(new ApiResponse(200, campaign, "Campaign stats refreshed successfully"));
});

export {
  createCampaign,
  getUserCampaigns,
  deleteCampaign,
  createSegment,
  getUserSegments,
  estimateSegment,
  getCommuniactionLog,
  getSegmentPreview,
  updateDeliveryStatus,
  getEmailSettings,
  updateEmailSettings,
  refreshCampaignStats
};
